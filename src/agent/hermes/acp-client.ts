import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

/**
 * Minimal JSON-RPC 2.0 client for Hermes's ACP (Agent Client Protocol) mode.
 *
 * `hermes acp` speaks newline-delimited JSON-RPC over stdio:
 *   - client → server requests: `initialize`, `session/new`, `session/prompt`,
 *     `session/stop`
 *   - server → client notifications: `session/update` (streamed events)
 *   - responses are matched by `id`
 *
 * Probed against Hermes Agent v0.20.1 (2026-08-17):
 *   - `session/new` result carries the session id as `sessionId`
 *   - `session/prompt` takes `sessionId` + `prompt` as a content-block array
 *   - updates carry a `sessionUpdate` discriminator: `agent_thought_chunk`,
 *     `agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`,
 *     `session_info_update`, or a bare `availableCommands` object
 *   - the turn ends when the `session/prompt` request itself is answered with
 *     `{ stopReason, usage }`
 */

export interface AcpUpdate {
  /** Discriminator field on real event updates. */
  sessionUpdate?: string;
  /** Present on tool events. */
  kind?: string;
  status?: string;
  toolCallId?: string;
  title?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface AcpPromptResult {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
    cachedReadTokens?: number;
  };
}

export interface AcpSessionInfo {
  sessionId: string;
  models: { availableModels?: unknown[] };
}

export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rl: ReturnType<typeof createInterface>;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private updateHandlers = new Set<(update: AcpUpdate) => void>();
  private closed = false;

  constructor(binary: string, args: string[]) {
    this.child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      this.dispatch(msg);
    });
    this.child.stderr.on('data', () => {
      /* hermes logs to stderr; ignored here (adapter surfaces it) */
    });
    this.child.on('error', (err) => {
      this.rejectAll(err);
    });
    this.child.on('exit', () => {
      this.closed = true;
      this.rejectAll(new Error('hermes acp process exited'));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exited(): boolean {
    return this.closed || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  onUpdate(handler: (update: AcpUpdate) => void): () => void {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  onStderr(handler: (chunk: Buffer) => void): void {
    this.child.stderr.on('data', handler);
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (typeof m.id === 'number' && this.pending.has(m.id)) {
      const entry = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) {
        entry.reject(new Error(JSON.stringify(m.error).slice(0, 300)));
      } else {
        entry.resolve(m.result);
      }
      return;
    }
    if (m.method === 'session/update') {
      const update = (m.params as { update?: AcpUpdate } | undefined)?.update;
      if (update) {
        for (const h of [...this.updateHandlers]) h(update);
      }
    }
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed || this.child.exitCode !== null) {
      return Promise.reject(new Error('hermes acp process is not running'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private rejectAll(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: {} },
    });
  }

  async newSession(cwd: string, opts: { resumeSessionId?: string } = {}): Promise<AcpSessionInfo> {
    const params: Record<string, unknown> = {
      cwd,
      mcpServers: [],
      clientCapabilities: { fs: {} },
    };
    if (opts.resumeSessionId) params.resumeSessionId = opts.resumeSessionId;
    const result = (await this.request('session/new', params)) as Record<string, unknown>;
    const sessionId = String(result?.sessionId ?? '');
    if (!sessionId) throw new Error('session/new returned no sessionId');
    return { sessionId, models: { availableModels: (result?.models as { availableModels?: unknown[] } | undefined)?.availableModels } };
  }

  /**
   * Send one prompt and wait for its own response (the turn-complete
   * signal). All `session/update` notifications received while the prompt is
   * in flight are collected and returned alongside the response
   * (`stopReason` / `usage`).
   */
  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ updates: AcpUpdate[]; result: AcpPromptResult }> {
    const params = {
      sessionId,
      prompt: [{ type: 'text', text }],
      mcpServers: [],
      clientCapabilities: { fs: {} },
    };
    const resultPromise = this.request<AcpPromptResult>('session/prompt', params);
    const updates: AcpUpdate[] = [];
    const off = this.onUpdate((u) => updates.push(u));
    try {
      const result = await resultPromise;
      return { updates, result };
    } finally {
      off();
    }
  }

  async stop(): Promise<void> {
    if (this.closed || this.child.exitCode !== null) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'session/stop', params: {} }) + '\n');
    } catch {
      /* ignore */
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.child.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.child.once('exit', onExit);
    });
  }
}
