import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildOpencodeArgs } from './argv';
import { OpencodeJsonlTranslator } from './jsonl';

export interface OpencodeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /** Forward `--thinking` so reasoning events appear in the JSONL stream. */
  thinking?: boolean;
  stopGraceMs?: number;
}

type OpencodeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class OpencodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly thinking: boolean;
  private readonly defaultStopGraceMs: number;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: OpencodeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'opencode';
    this.larkChannel = opts.larkChannel;
    this.thinking = opts.thinking === true;
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
      agentId: 'opencode',
      agentName: 'OpenCode',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for OpencodeAdapter.run');
    }

    // opencode takes the prompt as a positional argument (not stdin, unlike
    // mimo). The bridge system prompt is prefixed the same way. skipPermissions
    // maps the bridge access mode (forwarded as the codex-style sandbox
    // field): full -> --dangerously-skip-permissions; anything stricter
    // leaves the flag off and opencode decides on its own.
    const args = buildOpencodeArgs({
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      model: opts.model,
      thinking: this.thinking,
      skipPermissions: opts.sandbox === 'danger-full-access',
    });
    args.push(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity));

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as OpencodeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    // Listeners MUST be attached synchronously before returning — 'error' /
    // exit events can fire in the next tick and would be lost otherwise.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn opencode: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end();

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    let stopReason: 'interrupted' | undefined;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
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
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: OpencodeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => 'interrupted' | undefined,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn opencode: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const translator = new OpencodeJsonlTranslator();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // opencode may print non-JSON noise before the event stream; skip.
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    rl.close();
  }

  if (translator.terminalEmittedFlag()) return;

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.finish('interrupted');
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }
  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `opencode exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
    return;
  }
  if (runtimeError) {
    yield {
      type: 'error',
      message: `opencode runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // opencode exits when the session goes idle — stdout EOF is the end signal.
  yield* translator.finish('normal');
}

async function waitForExitCode(child: OpencodeChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /'(opencode)' is not recognized|'opencode' 不是内部或外部命令/i.test(line)
  );
}
