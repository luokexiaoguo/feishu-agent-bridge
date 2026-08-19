import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * Per-scope conversation history + compaction state for the bridge's
 * `/compact` feature.
 *
 * The bridge never held conversation transcripts before (history lives inside
 * each agent CLI). To give every agent a uniform context-compression command,
 * the bridge records each user message and each assistant reply per scope,
 * and `/compact` replaces the older portion with an LLM summary that is then
 * injected at the top of every future prompt (see channel.ts).
 *
 * One JSON file per scope under `<profileDir>/compact/<sha1(scope)>.json`,
 * written atomically with mode 0600.
 */

export interface CompactEntry {
  ts: number;
  role: 'user' | 'assistant';
  text: string;
}

export interface CompactState {
  /** Oldest → newest. Only entries that have NOT been compacted yet. */
  entries: CompactEntry[];
  /** Summary of all earlier (already-compacted) conversation. */
  summary?: string;
  summaryAt?: number;
  /** Cumulative number of rounds folded into `summary` (for display). */
  summaryRounds?: number;
}

export interface CompactApplyResult {
  removedRounds: number;
  removedChars: number;
  keptRounds: number;
  summaryChars: number;
}

/** Hard cap on retained entries per scope (oldest dropped first). */
const MAX_ENTRIES_PER_SCOPE = 2000;
/** Per-message cap so one huge paste cannot balloon the history file. */
const MAX_ENTRY_CHARS = 8_000;

function isEntry(value: unknown): value is CompactEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CompactEntry>;
  return (
    typeof entry.ts === 'number' &&
    (entry.role === 'user' || entry.role === 'assistant') &&
    typeof entry.text === 'string'
  );
}

function clipText(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > MAX_ENTRY_CHARS ? `${trimmed.slice(0, MAX_ENTRY_CHARS)}…` : trimmed;
}

export class CompactStore {
  private readonly states = new Map<string, CompactState | Promise<CompactState>>();
  private readonly saves = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  private fileFor(scope: string): string {
    const hash = createHash('sha1').update(scope).digest('hex').slice(0, 16);
    return join(this.dir, `${hash}.json`);
  }

  private async loadState(scope: string): Promise<CompactState> {
    try {
      const text = await readFile(this.fileFor(scope), 'utf8');
      const raw = JSON.parse(text) as Partial<CompactState>;
      return {
        entries: Array.isArray(raw.entries)
          ? raw.entries.filter(isEntry).slice(-MAX_ENTRIES_PER_SCOPE)
          : [],
        ...(typeof raw.summary === 'string' && raw.summary.trim() ? { summary: raw.summary } : {}),
        ...(typeof raw.summaryAt === 'number' ? { summaryAt: raw.summaryAt } : {}),
        ...(typeof raw.summaryRounds === 'number' ? { summaryRounds: raw.summaryRounds } : {}),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
      throw err;
    }
  }

  private async stateFor(scope: string): Promise<CompactState> {
    const hit = this.states.get(scope);
    if (hit && !(hit instanceof Promise)) return hit;
    if (hit) return hit; // already loading — await the in-flight load
    const loading = this.loadState(scope);
    this.states.set(scope, loading);
    try {
      const state = await loading;
      this.states.set(scope, state);
      return state;
    } catch (err) {
      this.states.delete(scope);
      throw err;
    }
  }

  private persist(scope: string, state: CompactState): void {
    const path = this.fileFor(scope);
    const prev = this.saves.get(scope) ?? Promise.resolve();
    const next = prev
      .then(() => writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }))
      .catch((err: unknown) => log.fail('compact', err, { scope, step: 'persist' }));
    this.saves.set(scope, next);
  }

  private async append(scope: string, role: CompactEntry['role'], text: string): Promise<void> {
    const clipped = clipText(text);
    if (!clipped) return;
    const state = await this.stateFor(scope);
    state.entries.push({ ts: Date.now(), role, text: clipped });
    if (state.entries.length > MAX_ENTRIES_PER_SCOPE) {
      state.entries.splice(0, state.entries.length - MAX_ENTRIES_PER_SCOPE);
    }
    this.persist(scope, state);
  }

  /** Record a user message for this scope (oldest → newest order). */
  async appendUser(scope: string, text: string): Promise<void> {
    await this.append(scope, 'user', text);
  }

  /** Record the assistant's final reply for this scope. */
  async appendAssistant(scope: string, text: string): Promise<void> {
    await this.append(scope, 'assistant', text);
  }

  /** Current uncompacted entries for this scope (oldest → newest). */
  async entries(scope: string): Promise<readonly CompactEntry[]> {
    const state = await this.stateFor(scope);
    return state.entries.slice();
  }

  /** The currently active compaction summary, if any. */
  async summary(scope: string): Promise<string | undefined> {
    const state = await this.stateFor(scope);
    return state.summary;
  }

  /**
   * Fold `entries[0..keepFrom)` into a new summary and keep the rest.
   * `summary` is the merged output of the summary LLM (old summary + removed
   * portion). Returns stats for the confirmation reply.
   */
  async applyCompaction(
    scope: string,
    keepFrom: number,
    summary: string,
  ): Promise<CompactApplyResult> {
    const state = await this.stateFor(scope);
    const removed = state.entries.slice(0, keepFrom);
    const kept = state.entries.slice(keepFrom);
    const removedRounds = removed.filter((entry) => entry.role === 'user').length;
    const removedChars = removed.reduce((total, entry) => total + entry.text.length, 0);
    state.entries = kept;
    state.summary = summary.trim();
    state.summaryAt = Date.now();
    state.summaryRounds = (state.summaryRounds ?? 0) + removedRounds;
    this.persist(scope, state);
    return {
      removedRounds,
      removedChars,
      keptRounds: kept.filter((entry) => entry.role === 'user').length,
      summaryChars: summary.trim().length,
    };
  }

  /** Wipe all recorded history + summary (used by /new). */
  async reset(scope: string): Promise<void> {
    const state = await this.stateFor(scope);
    state.entries = [];
    delete state.summary;
    delete state.summaryAt;
    delete state.summaryRounds;
    this.persist(scope, state);
  }

  /** Await all pending writes (used on shutdown / tests). */
  async flush(): Promise<void> {
    await Promise.all(this.saves.values());
  }
}
