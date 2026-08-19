import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * LLM client used by the bridge's /compact context-compression feature.
 *
 * The bridge itself has no model API of its own, so compaction summarizes
 * conversation history through an OpenAI-compatible endpoint. The default is
 * the machine-local new-api proxy that 玄策 (hermes) already uses
 * (`http://localhost:3000/v1` + `deepseek-v4-flash`), whose key lives in
 * `~/.hermes/.env` as `LOCAL_DEEPSEEK_API_KEY`.
 */

export const DEFAULT_COMPACT_BASE_URL = 'http://localhost:3000/v1';
export const DEFAULT_COMPACT_MODEL = 'deepseek-v4-flash';
export const DEFAULT_COMPACT_TIMEOUT_MS = 30_000;

const HERMES_ENV_PATH = join(homedir(), '.hermes', '.env');

/**
 * Resolve the API key for the compaction LLM, in order:
 * 1. explicitly configured `compaction.llm.apiKey`
 * 2. env var `LOCAL_DEEPSEEK_API_KEY`
 * 3. `LOCAL_DEEPSEEK_API_KEY` from `~/.hermes/.env` (玄策's local new-api key)
 */
export async function resolveCompactApiKey(configured?: string): Promise<string | undefined> {
  if (configured && configured.trim()) return configured.trim();
  if (process.env.LOCAL_DEEPSEEK_API_KEY?.trim()) return process.env.LOCAL_DEEPSEEK_API_KEY.trim();
  try {
    const text = await readFile(HERMES_ENV_PATH, 'utf8');
    const match = text.match(/^\s*LOCAL_DEEPSEEK_API_KEY\s*=\s*(.+)\s*$/m);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '');
    return value || undefined;
  } catch {
    // No ~/.hermes/.env — the caller will surface a clear missing-key error.
    return undefined;
  }
}

const SYSTEM_PROMPT = `你是一个飞书 AI 助手的会话压缩器。用户会给你两段材料：
1. 【已有的早期对话摘要】（可选，可能为空）
2. 【本次待压缩的对话记录】

请把「已有摘要 + 本次对话记录」合并压缩成一份新的早期对话摘要，规则：
- 用中文输出，Markdown 无序列表，每个要点一行，总长度不超过 600 字
- 必须保留：用户的明确偏好/决定/要求、已完成事项与结论、未完成或待办事项、关键文件名/路径/数字/配置/账号信息
- 可以丢弃：问候寒暄、重复表达、工具调用细节、纯情绪化内容
- 不要编造对话里没有出现过的信息；已有摘要里的内容若与对话不冲突就保留
- 输出只有摘要本体，不要任何前后缀、标题或说明`;

export interface SummarizeConversationInput {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Optional previous compaction summary to merge into the new one. */
  oldSummary?: string;
  /** The raw conversation transcript to compress (oldest → newest). */
  transcript: string;
  timeoutMs?: number;
}

/**
 * Call the OpenAI-compatible endpoint and return the compressed summary.
 * Throws on transport errors, non-2xx status, or an empty completion.
 */
export async function summarizeConversation(
  input: SummarizeConversationInput,
): Promise<string> {
  const {
    baseUrl,
    model,
    apiKey,
    oldSummary,
    transcript,
    timeoutMs = DEFAULT_COMPACT_TIMEOUT_MS,
  } = input;

  const userContent = [
    ...(oldSummary && oldSummary.trim()
      ? [`【已有的早期对话摘要】\n${oldSummary.trim()}`, '---']
      : []),
    `【本次待压缩的对话记录】\n${transcript}`,
  ].join('\n');

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        // deepseek-v4-flash 是推理模型，reasoning 会先占掉一部分 token；
        // 给足余量避免长对话摘要被截断成空。
        max_tokens: 2500,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(
      `摘要模型请求失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`摘要模型返回 ${res.status}: ${detail || res.statusText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('摘要模型返回了空内容');
  }
  return content.trim();
}

/**
 * Build the summarizer prompt handed to an agent CLI when no dedicated
 * summary LLM key is configured. Kept in sync with {@link SYSTEM_PROMPT}.
 */
export function buildAgentSummaryPrompt(input: {
  oldSummary?: string;
  transcript: string;
}): string {
  const { oldSummary, transcript } = input;
  const parts = [
    '你是会话压缩器。把下面这段对话历史压缩成一份「早期对话摘要」。规则：',
    '- 用中文输出，Markdown 无序列表，每个要点一行，总长度不超过 600 字',
    '- 必须保留：用户的明确偏好/决定/要求、已完成事项与结论、未完成或待办事项、关键文件名/路径/数字/配置/账号信息',
    '- 可以丢弃：问候寒暄、重复表达、工具调用细节、纯情绪化内容',
    '- 不要编造对话里没有出现过的信息',
    '- 输出只有摘要本体，不要任何前后缀、标题或说明',
    '',
  ];
  if (oldSummary && oldSummary.trim()) {
    parts.push(`【已有的早期对话摘要】\n${oldSummary.trim()}`, '---');
  }
  parts.push(`【本次待压缩的对话记录】\n${transcript}`);
  return parts.join('\n');
}

export interface SummarizeViaAgentInput {
  adapter: import('../agent/types').AgentAdapter;
  cwd?: string;
  oldSummary?: string;
  transcript: string;
  timeoutMs?: number;
}

/**
 * Fallback summarizer: reuse the profile's own agent CLI (e.g. claude) to
 * produce the summary. This is what makes `/compact` work out-of-the-box on
 * machines that have a configured agent but no dedicated LLM API key.
 *
 * Spawns the agent with a pure summarization prompt (no session resume, no
 * bridge context) and collects its final text. Throws on agent errors or
 * timeout.
 */
export async function summarizeViaAgent(
  input: SummarizeViaAgentInput,
): Promise<string> {
  const { adapter, cwd, oldSummary, transcript, timeoutMs = DEFAULT_COMPACT_TIMEOUT_MS } = input;
  const run = adapter.run({
    runId: `compact-${Math.random().toString(36).slice(2, 10)}`,
    prompt: buildAgentSummaryPrompt({ oldSummary, transcript }),
    ...(cwd ? { cwd } : {}),
    permissionMode: 'bypassPermissions',
    stopGraceMs: 5000,
  });

  let text = '';
  let error: string | undefined;
  const finished = (async () => {
    for await (const evt of run.events) {
      if (evt.type === 'text') text += evt.delta;
      else if (evt.type === 'final_text') text = evt.content;
      else if (evt.type === 'error') {
        error = evt.message;
        break;
      }
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Agent 挂起时停止它，并立即以超时失败返回——即使事件流不结束，
      // Promise.race 也能让 /compact 及时报错而不是卡死。
      void run.stop().catch(() => undefined);
      reject(new Error(`用 ${adapter.displayName} 做摘要超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });

  try {
    await Promise.race([finished, timedOut]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (error) throw new Error(`用 ${adapter.displayName} 做摘要失败：${error}`);
  const summary = text.trim();
  if (!summary) throw new Error(`用 ${adapter.displayName} 做摘要返回了空内容`);
  return summary;
}

export interface SummarizeViaClaudeNativeInput {
  adapter: import('../agent/types').AgentAdapter;
  /** The claude session to compact (must already exist — resume target). */
  sessionId: string;
  cwd?: string;
  /** Optional focus instructions forwarded to `/compact <focus>`. */
  focus?: string;
  timeoutMs?: number;
}

/**
 * Claude-native compaction passthrough: run `/compact` directly against the
 * claude CLI resumed session (`claude -p --resume <session> "/compact"`).
 * This is a real terminal-passthrough — Claude Code's own compaction (the
 * same as the TUI's `/compact`) summarizes the conversation and rewrites the
 * session file; the next resumed run carries the compacted context.
 *
 * Compaction is silent in stream-json mode (no text events); completion is
 * signalled by the process exiting 0. Errors surface as `error` events.
 * Returns `true` on success.
 */
export async function summarizeViaClaudeNative(
  input: SummarizeViaClaudeNativeInput,
): Promise<boolean> {
  const { adapter, sessionId, cwd, focus, timeoutMs = DEFAULT_COMPACT_TIMEOUT_MS } = input;
  const focusText = focus?.trim();
  const run = adapter.run({
    runId: `compact-native-${Math.random().toString(36).slice(2, 10)}`,
    prompt: focusText ? `/compact ${focusText}` : '/compact',
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
      reject(new Error(`Claude 原生压缩超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });

  try {
    await Promise.race([finished, timedOut]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (error) throw new Error(`Claude 原生压缩失败：${error}`);
  return true;
}
