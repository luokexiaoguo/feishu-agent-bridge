import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../core/logger';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildOpenClawArgs } from './argv';

export interface OpenClawAdapterOptions {
  binary?: string;
  /** The OpenClaw agent id (e.g. "main"). */
  agentId: string;
  /** Thinking level passed through to `--thinking` when set. */
  thinking?: string;
  stopGraceMs?: number;
}

/**
 * OpenClaw adapter — runs one headless agent turn via
 * `openclaw agent --json` and emits the final answer.
 *
 * NOTE: `agent --json` returns only the final text (no streaming reasoning /
 * tool events), so the CoT bubble shows the answer without the live process.
 * The ACP route (`openclaw acp`, same protocol as the hermes adapter) would
 * give the full streaming experience but requires a gateway scope approval —
 * this adapter is the zero-friction baseline.
 */
export class OpenClawAdapter implements AgentAdapter {
  readonly id = 'openclaw';
  readonly displayName = 'OpenClaw';

  private readonly binary: string;
  private readonly agentId: string;
  private readonly thinking: string | undefined;
  private readonly defaultStopGraceMs: number;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: OpenClawAdapterOptions) {
    this.binary = opts.binary ?? 'openclaw';
    this.agentId = opts.agentId;
    this.thinking = opts.thinking;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'openclaw',
      agentName: 'OpenClaw',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for OpenClawAdapter.run');
    }
    // Write the prompt to a temp file (argv must stay small).
    const tmpDir = mkdtempSync(join(tmpdir(), 'openclaw-bridge-'));
    const msgFile = join(tmpDir, 'prompt.txt');
    writeFileSync(msgFile, opts.prompt, 'utf8');

    const args = buildOpenClawArgs({
      agentId: this.agentId,
      messageFile: msgFile,
      sessionId: opts.sessionId,
      model: opts.model,
      thinking: this.thinking,
    });

    log.info('agent', 'spawn', {
      binary: this.binary,
      args: args.slice(0, 4),
      agentId: this.agentId,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      const text = chunk.toString('utf8').trim();
      if (text && !/state\/db|readonly|hardening/i.test(text)) {
        log.warn('agent', 'stderr', { line: text.slice(0, 300) });
      }
    });
    child.on('error', (err) => {
      runtimeError = err;
    });

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    let stopReason: 'interrupted' | undefined;

    return {
      runId: opts.runId,
      events: createEventStream({
        child,
        msgFile,
        tmpDir,
        stderrChunks,
        getError: () => runtimeError,
        getStopReason: () => stopReason,
      }),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          child.once('exit', onExit);
        });
      },
    };
  }
}

interface StreamContext {
  child: ReturnType<typeof spawn>;
  msgFile: string;
  tmpDir: string;
  stderrChunks: Buffer[];
  getError: () => Error | null;
  getStopReason: () => 'interrupted' | undefined;
}

async function* createEventStream(ctx: StreamContext): AsyncGenerator<AgentEvent> {
  const { child } = ctx;
  let stdout = '';
  try {
    for await (const chunk of child.stdout ?? new (require("node:stream").Readable)()) {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8 * 1024 * 1024) {
        // Guard against runaway output; the JSON result is small.
        child.kill('SIGKILL');
        break;
      }
    }
  } catch {
    /* ignore stream errors */
  }

  const exitCode = await waitForExitCode(child);
  cleanup(ctx);

  const stopReason = ctx.getStopReason();
  if (stopReason) {
    yield { type: 'done', terminationReason: stopReason };
    return;
  }
  const runtimeError = ctx.getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(ctx.stderrChunks).toString('utf8').trim();
    yield {
      type: 'error',
      message: `openclaw agent exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
      terminationReason: 'failed',
    };
    return;
  }
  if (runtimeError) {
    yield {
      type: 'error',
      message: `openclaw spawn failed: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // Parse the JSON result.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    yield {
      type: 'error',
      message: `openclaw agent returned unparsable output: ${stdout.slice(0, 200)}`,
      terminationReason: 'failed',
    };
    return;
  }
  const result = parsed as {
    status?: string;
    result?: {
      payloads?: Array<{ text?: string }>;
      meta?: { agentMeta?: { sessionId?: string; usage?: { input?: number; output?: number } } };
    };
  };
  const payloads = result.result?.payloads ?? [];
  const text = payloads.map((p) => p.text ?? '').join('\n').trim();
  // sessionId/usage live under meta.agentMeta (probed 2026-08-17).
  const agentMeta = result.result?.meta?.agentMeta ?? {};
  const sessionId = agentMeta.sessionId;
  if (result.status !== 'ok' && !text) {
    yield {
      type: 'error',
      message: `openclaw agent failed: ${JSON.stringify(result).slice(0, 300)}`,
      terminationReason: 'failed',
    };
    return;
  }

  yield { type: 'system', sessionId, cwd: undefined };
  if (text) yield { type: 'final_text', content: text };
  if (agentMeta.usage) {
    yield { type: 'usage', inputTokens: agentMeta.usage.input, outputTokens: agentMeta.usage.output };
  }
  yield { type: 'done', sessionId, terminationReason: 'normal' };
}

function cleanup(ctx: StreamContext): void {
  try {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function waitForExitCode(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}
