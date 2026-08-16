import { log } from '../../core/logger';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { AcpConnection, type AcpPromptResult, type AcpUpdate } from './acp-client';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';

export interface HermesAdapterOptions {
  binary?: string;
  /** Extra args for `hermes acp`, e.g. `['--profile', 'tomato-studio']`. */
  acpArgs?: string[];
  larkChannel?: LarkChannelEnvContext;
  stopGraceMs?: number;
}

type HermesChild = AcpConnection;

export class HermesAdapter implements AgentAdapter {
  readonly id = 'hermes';
  readonly displayName = 'Hermes Agent';

  private readonly binary: string;
  private readonly acpArgs: string[];
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly defaultStopGraceMs: number;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: HermesAdapterOptions = {}) {
    this.binary = opts.binary ?? 'hermes';
    this.acpArgs = opts.acpArgs ?? [];
    this.larkChannel = opts.larkChannel;
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
      agentId: 'hermes',
      agentName: 'Hermes Agent',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for HermesAdapter.run');
    }

    const args = [...this.acpArgs, 'acp'];
    log.info('agent', 'spawn', {
      binary: this.binary,
      args,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const child = new AcpConnection(this.binary, args);
    const stderrChunks: Buffer[] = [];
    child.onStderr((chunk: Buffer) => {
      stderrChunks.push(chunk);
      const text = chunk.toString('utf8').trim();
      if (text) log.warn('agent', 'stderr', { line: text.slice(0, 300) });
    });

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    let stopReason: 'interrupted' | undefined;

    return {
      runId: opts.runId,
      events: createEventStream({
        child,
        cwd: opts.cwd,
        prompt: prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
        resumeSessionId: opts.sessionId,
        stderrChunks,
        getStopReason: () => stopReason,
      }),
      async stop() {
        if (child.exited) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        await child.stop().catch(() => undefined);
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!child.exited) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          void child.waitForExit(stopGraceMs).then((exited) => {
            if (exited) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return child.waitForExit(timeoutMs);
      },
    };
  }
}

interface StreamContext {
  child: HermesChild;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  stderrChunks: Buffer[];
  getStopReason: () => 'interrupted' | undefined;
}

async function* createEventStream(ctx: StreamContext): AsyncGenerator<AgentEvent> {
  const { child } = ctx;
  if (!child.pid) {
    yield {
      type: 'error',
      message: `failed to spawn hermes acp (no pid)`,
      terminationReason: 'failed',
    };
    return;
  }

  let sessionId: string | undefined;
  let finalText = '';
  let terminalEmitted = false;
  // diagnostics: how many reasoning/tool events actually flowed this run
  const diag = { thinking: 0, toolUse: 0, toolResult: 0 };

  const emitError = (message: string): AgentEvent => ({
    type: 'error',
    message,
    terminationReason: 'failed',
  });

  try {
    await child.initialize();
  } catch (err) {
    yield emitError(`hermes acp initialize failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    const info = await child.newSession(ctx.cwd, {
      ...(ctx.resumeSessionId ? { resumeSessionId: ctx.resumeSessionId } : {}),
    });
    sessionId = info.sessionId;
    yield { type: 'system', sessionId, cwd: ctx.cwd };
  } catch (err) {
    yield emitError(`hermes session/new failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let promptResult: AcpPromptResult | undefined;
  try {
    const { updates, result } = await child.prompt(sessionId, ctx.prompt);
    promptResult = result;
    for (const update of updates) {
      for (const ev of translateUpdate(update)) {
        if (ev.type === 'text') {
          // Answer chunks are accumulated, not streamed into the CoT bubble —
          // reasoning + tools live in the bubble, the answer goes out as a
          // plain message at the end (mirroring dsh-lark).
          finalText += (ev as { delta: string }).delta;
          continue;
        }
        if (ev.type === 'thinking') diag.thinking++;
        if (ev.type === 'tool_use') diag.toolUse++;
        if (ev.type === 'tool_result') diag.toolResult++;
        yield ev;
      }
    }
    log.info('agent', 'hermes-events', { sessionId, thinking: diag.thinking, toolUse: diag.toolUse, toolResult: diag.toolResult });
  } catch (err) {
    if (ctx.getStopReason()) {
      yield { type: 'done', sessionId, terminationReason: 'interrupted' };
      terminalEmitted = true;
    } else {
      yield emitError(`hermes prompt failed: ${err instanceof Error ? err.message : String(err)}`);
      terminalEmitted = true;
    }
  }

  if (!terminalEmitted) {
    const stopReason = ctx.getStopReason();
    if (stopReason) {
      yield { type: 'done', sessionId, terminationReason: stopReason };
    } else {
      const usage = promptResult?.usage;
      const events: AgentEvent[] = [];
      if (finalText.trim()) {
        events.push({ type: 'final_text', content: finalText });
      }
      if (usage) {
        events.push({
          type: 'usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: undefined,
        });
      }
      events.push({ type: 'done', sessionId, terminationReason: 'normal' });
      yield* events;
    }
  }
}

/**
 * Translate one ACP session/update into bridge AgentEvents.
 *
 * Probed against Hermes Agent v0.20.1:
 *   - `agent_thought_chunk`   → reasoning delta (CoT bubble)
 *   - `agent_message_chunk`   → answer delta (accumulated as final_text; the
 *     caller routes it via the text event and sums it)
 *   - `tool_call`             → tool started
 *   - `tool_call_update`      → tool finished (status + output)
 *   - `usage_update` / `session_info_update` / availableCommands → ignored
 *     (usage rides the prompt response)
 */
export function translateUpdate(update: AcpUpdate): AgentEvent[] {
  const kind = update.sessionUpdate;
  const events: AgentEvent[] = [];
  switch (kind) {
    case 'agent_thought_chunk': {
      const text = (update.content as { text?: string } | undefined)?.text;
      if (text) events.push({ type: 'thinking', delta: text });
      break;
    }
    case 'agent_message_chunk': {
      const text = (update.content as { text?: string } | undefined)?.text;
      if (text) events.push({ type: 'text', delta: text });
      break;
    }
    case 'tool_call': {
      const id = String(update.toolCallId ?? '');
      const name = String(update.kind ?? update.title ?? 'tool');
      const input = update.content;
      if (id) events.push({ type: 'tool_use', id, name, input });
      break;
    }
    case 'tool_call_update': {
      const id = String(update.toolCallId ?? '');
      if (id) {
        const isError = update.status !== 'completed';
        // tool_call_update content shapes (probed):
        //   [ {content:{text},type:'content'}, ... ]   (list of parts)
        //   { content: {text} } | { text }              (single)
        const raw = update.content as unknown;
        let output = '';
        if (Array.isArray(raw)) {
          output = raw
            .map((c) => {
              if (!c || typeof c !== 'object') return '';
              const part = c as Record<string, unknown>;
              const inner = part.content as { text?: string } | undefined;
              return String(inner?.text ?? '');
            })
            .join('\n');
        } else if (raw && typeof raw === 'object') {
          const obj = raw as Record<string, unknown>;
          const inner = obj.content;
          if (inner && typeof inner === 'object') {
            output = String((inner as { text?: string }).text ?? '');
          } else {
            output = String((obj as { text?: string }).text ?? '');
          }
        }
        events.push({ type: 'tool_result', id, output, isError });
      }
      break;
    }
    default:
      break;
  }
  return events;
}
