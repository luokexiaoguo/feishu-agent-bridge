import type { AgentRun } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Set<string>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    this.reservations.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
    };
  }

  register(chatId: string, run: AgentRun): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle: RunHandle = { run, interrupted: false };
    this.handles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    this.reservations.delete(chatId);
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    this.reservations.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }

  /**
   * Wait until every in-flight run has *finished* (its handle is gone — the
   * run's event stream reached a terminal event and the executor cleanup
   * unregistered it), or the timeout elapses. Returns true when idle.
   *
   * Unlike `waitForAll` (which waits for the child process to exit, and
   * mimo never exits on its own until its checkpoint-writer finishes), this
   * keys off run completion, so a finished-but-not-yet-exited mimo child
   * does not hold up a graceful disconnect.
   */
  async waitForIdle(timeoutMs = 90_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.handles.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    return this.handles.size === 0;
  }
}
