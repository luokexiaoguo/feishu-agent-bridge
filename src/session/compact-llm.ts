import { spawn } from 'node:child_process';
import { log } from '../core/logger';

/**
 * Native context-compaction passthroughs.
 *
 * The bridge's `/compact` command is a pure mediator: it dispatches the
 * agent CLI's OWN compaction command and reports the result. No transcript
 * recording, no summarizer LLM, no injected summaries — the bridge just
 * connects Feishu to the CLI, and each agent's native compaction does the
 * real work (verified per agent):
 *
 * - claude:   `claude -p --resume <session> "/compact [focus]"`
 *             (headless mode accepts the slash command; query_source: compact)
 * - mimo:     `mimo run --session <id> "/compact"`
 *             (client parses the slash command; "会话状态已压缩归档")
 * - openclaw: `openclaw sessions compact <key>`
 *             (dedicated CLI command; "Compacted session ...")
 */

export const DEFAULT_COMPACT_TIMEOUT_MS = 30_000;

export interface RunNativeCompactInput {
  adapter: import('../agent/types').AgentAdapter;
  /** The agent session to compact (must already exist — resume target). */
  sessionId: string;
  /** The exact command string to send, e.g. `/compact` or `/compact <focus>`. */
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Generic passthrough for adapters whose run() accepts a session id and
 * interprets a `/compact` slash command client-side (claude, mimo).
 * Consumes the event stream to completion; errors surface as thrown
 * exceptions. Returns true on success.
 */
export async function runNativeCompact(input: RunNativeCompactInput): Promise<boolean> {
  const { adapter, sessionId, command, cwd, timeoutMs = DEFAULT_COMPACT_TIMEOUT_MS } = input;
  const run = adapter.run({
    runId: `compact-native-${Math.random().toString(36).slice(2, 10)}`,
    prompt: command,
    sessionId,
    ...(cwd ? { cwd } : {}),
    permissionMode: 'bypassPermissions',
    stopGraceMs: 5000,
  });

  let error: string | undefined;
  const finished = (async () => {
    for await (const evt of run.events) {
      if (evt.type === 'error') {
        error = evt.message;
        break;
      }
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void run.stop().catch(() => undefined);
      reject(new Error(`${adapter.displayName} 原生压缩超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });

  try {
    await Promise.race([finished, timedOut]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (error) throw new Error(`${adapter.displayName} 原生压缩失败：${error}`);
  return true;
}

export interface CompactOpenClawSessionInput {
  /** Path to the openclaw binary (from openclaw.binaryPath). */
  binary: string;
  /** OpenClaw agent id owning the session (e.g. "main"). */
  agentId: string;
  /** The bridge-recorded session id (openclaw's system id). */
  sessionId: string;
  timeoutMs?: number;
}

function runCli(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`openclaw 命令超时（${timeoutMs}ms）: openclaw ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * OpenClaw native compaction: resolve the session key from
 * `openclaw sessions list --json` (matching the recorded system id), then
 * run `openclaw sessions compact <key>`.
 */
export async function compactOpenClawSession(
  input: CompactOpenClawSessionInput,
): Promise<boolean> {
  const { binary, agentId, sessionId, timeoutMs = DEFAULT_COMPACT_TIMEOUT_MS } = input;

  const list = await runCli(binary, ['sessions', 'list', '--json'], timeoutMs);
  if (list.code !== 0) {
    throw new Error(`openclaw sessions list 失败（${list.code}）: ${list.stderr.trim().slice(0, 200)}`);
  }
  if (!list.stdout.trim()) {
    throw new Error('openclaw sessions list 返回空输出（exit 0）——请确认 openclaw gateway 可用');
  }
  let sessions: Array<{ key?: string; sessionId?: string }> = [];
  try {
    const parsed = JSON.parse(list.stdout) as unknown;
    sessions = Array.isArray(parsed)
      ? (parsed as Array<{ key?: string; sessionId?: string }>)
      : (((parsed as { sessions?: unknown })?.sessions) as Array<{ key?: string; sessionId?: string }> | undefined) ?? [];
  } catch {
    throw new Error('openclaw sessions list 输出无法解析');
  }

  const match = sessions.find((s) => s.sessionId === sessionId);
  if (!match?.key) {
    throw new Error(`找不到 openclaw 会话（sessionId=${sessionId}），可能已清理，请先聊几轮`);
  }

  const compact = await runCli(
    binary,
    ['sessions', 'compact', match.key, '--agent', agentId],
    timeoutMs,
  );
  if (compact.code !== 0) {
    // "Already compacted" is benign — compaction already happened.
    if (/already compacted/i.test(compact.stdout + compact.stderr)) return true;
    throw new Error(
      `openclaw sessions compact 失败（${compact.code}）: ${(compact.stderr || compact.stdout).trim().slice(0, 200)}`,
    );
  }
  log.info('compact', 'openclaw-done', { key: match.key });
  return true;
}
