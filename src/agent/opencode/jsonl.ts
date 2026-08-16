import type { AgentEvent } from '../types';

/**
 * Translator for `opencode run --format json` (JSONL on stdout).
 *
 * Event envelope per line: `{ type, timestamp, sessionID, ...data }`.
 * Event types (opencode >= 1.x, see packages/opencode/src/cli/cmd/run.ts):
 *   - `step_start`   — a processing step began (no bridge-relevant payload)
 *   - `text`         — one complete text block (block-level, NOT token deltas)
 *   - `reasoning`    — one complete reasoning block (needs `--thinking`)
 *   - `tool_use`     — tool call that reached a terminal state (completed /
 *                      error; there is no running-state event in JSON mode)
 *   - `step_finish`  — step ended, carries `part.tokens` usage/cost when set
 *   - `error`        — session error
 *
 * There is no explicit `done` event: the CLI exits once the session goes
 * idle, so the adapter emits `done` when stdout reaches EOF. `step_finish`
 * can occasionally be dropped before idle (upstream quirk) — the translator
 * tolerates that.
 */
interface OpencodePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  callID?: string;
  tool?: string;
  text?: string;
  time?: { end?: number };
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    title?: string;
    error?: string;
  };
  tokens?: Record<string, unknown>;
}

interface OpencodeRawEvent {
  type?: string;
  sessionID?: string;
  part?: OpencodePart;
  error?: { name?: string; data?: { message?: string; statusCode?: number } };
}

function toNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export class OpencodeJsonlTranslator {
  private sessionId: string | undefined;
  private terminalEmitted = false;

  translate(raw: unknown): AgentEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const evt = raw as OpencodeRawEvent;
    const events: AgentEvent[] = [];

    if (typeof evt.sessionID === 'string' && !this.sessionId) {
      this.sessionId = evt.sessionID;
      events.push({ type: 'system', sessionId: evt.sessionID });
    }

    switch (evt.type) {
      case 'text': {
        const text = evt.part?.text;
        if (text) events.push({ type: 'text', delta: text });
        break;
      }
      case 'reasoning': {
        const text = evt.part?.text;
        if (text) events.push({ type: 'thinking', delta: text });
        break;
      }
      case 'tool_use': {
        const part = evt.part;
        if (part?.callID && part.tool) {
          const isError = part.state?.status === 'error';
          const rawOutput = isError ? part.state?.error : part.state?.output;
          const output =
            typeof rawOutput === 'string'
              ? rawOutput
              : rawOutput === undefined
                ? ''
                : JSON.stringify(rawOutput);
          // opencode only reports terminal tool states; emit open+close in
          // one pass so the CoT renderer sees a complete call.
          events.push({
            type: 'tool_use',
            id: part.callID,
            name: part.tool,
            input: part.state?.input,
          });
          events.push({ type: 'tool_result', id: part.callID, output, isError });
        }
        break;
      }
      case 'step_finish': {
        const tokens = evt.part?.tokens;
        if (tokens && typeof tokens === 'object') {
          events.push({
            type: 'usage',
            inputTokens: toNumber(tokens.input),
            outputTokens: toNumber(tokens.output),
            costUsd: toNumber(tokens.cost),
          });
        }
        break;
      }
      case 'error': {
        const message =
          evt.error?.data?.message ?? evt.error?.name ?? 'opencode error';
        events.push({ type: 'error', message, terminationReason: 'failed' });
        this.terminalEmitted = true;
        break;
      }
      default:
        break;
    }
    return events;
  }

  terminalEmittedFlag(): boolean {
    return this.terminalEmitted;
  }

  /**
   * Emit the terminal `done` event. Called once stdout is exhausted (the CLI
   * exited, which is opencode's only end signal). Returns nothing once a
   * terminal event has already been emitted (e.g. `error`).
   */
  finish(reason: 'normal' | 'interrupted' | 'timeout' = 'normal'): AgentEvent[] {
    if (this.terminalEmitted) return [];
    this.terminalEmitted = true;
    return [{ type: 'done', sessionId: this.sessionId, terminationReason: reason }];
  }
}
