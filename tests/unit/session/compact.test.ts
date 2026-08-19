import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactStore } from '../../../src/session/compact.js';
import { summarizeConversation } from '../../../src/session/compact-llm.js';

describe('CompactStore', () => {
  let dir: string;
  let store: CompactStore;
  const cleanup: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'compact-store-'));
    cleanup.push(dir);
    store = new CompactStore(dir);
  });

  afterEach(async () => {
    await store?.flush();
    await Promise.all(
      cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
    );
  });

  it('appends entries in order and returns them oldest → newest', async () => {
    await store.appendUser('scope', '你好');
    await store.appendAssistant('scope', '你好！有什么可以帮你？');
    await store.appendUser('scope', '帮我总结一下');
    const entries = await store.entries('scope');
    expect(entries.map((e) => [e.role, e.text])).toEqual([
      ['user', '你好'],
      ['assistant', '你好！有什么可以帮你？'],
      ['user', '帮我总结一下'],
    ]);
  });

  it('keeps scopes isolated', async () => {
    await store.appendUser('chat-a', 'A 的问题');
    await store.appendUser('chat-b', 'B 的问题');
    expect((await store.entries('chat-a')).map((e) => e.text)).toEqual(['A 的问题']);
    expect((await store.entries('chat-b')).map((e) => e.text)).toEqual(['B 的问题']);
  });

  it('persists state across instances', async () => {
    await store.appendUser('scope', '第一条');
    await store.flush();
    const reloaded = new CompactStore(dir);
    const entries = await reloaded.entries('scope');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('第一条');
  });

  it('applyCompaction folds older rounds into a summary and keeps the rest', async () => {
    // 4 user rounds with replies
    for (let i = 1; i <= 4; i += 1) {
      await store.appendUser('scope', `问题 ${i}`);
      await store.appendAssistant('scope', `回答 ${i}`);
    }
    // Keep the newest 2 rounds → fold entries[0..4) (rounds 1-2) into summary
    const userIndexes = (await store.entries('scope'))
      .map((e, i) => (e.role === 'user' ? i : -1))
      .filter((i) => i >= 0);
    const keepFrom = userIndexes[userIndexes.length - 2] ?? 0; // 4th user msg index
    const result = await store.applyCompaction('scope', keepFrom, '【摘要】问题 1、2 的要点。');

    expect(result.removedRounds).toBe(2);
    expect(result.keptRounds).toBe(2);
    expect(await store.summary('scope')).toBe('【摘要】问题 1、2 的要点。');
    const remaining = await store.entries('scope');
    expect(remaining.map((e) => e.text)).toEqual(['问题 3', '回答 3', '问题 4', '回答 4']);
  });

  it('keeps the previous summary when compacting again', async () => {
    for (let i = 1; i <= 6; i += 1) {
      await store.appendUser('scope', `问题 ${i}`);
      await store.appendAssistant('scope', `回答 ${i}`);
    }
    const userIndexes = (await store.entries('scope'))
      .map((e, i) => (e.role === 'user' ? i : -1))
      .filter((i) => i >= 0);
    await store.applyCompaction('scope', userIndexes[userIndexes.length - 4] ?? 0, '摘要一');
    // Second compaction: fold all remaining into a merged summary
    const all = (await store.entries('scope')).length;
    const result = await store.applyCompaction('scope', all, '摘要二（含摘要一）');
    expect(result.removedRounds).toBe(4);
    expect(result.keptRounds).toBe(0);
    expect(await store.summary('scope')).toBe('摘要二（含摘要一）');
    expect(await store.entries('scope')).toHaveLength(0);
  });

  it('reset wipes entries and summary', async () => {
    await store.appendUser('scope', '问题');
    await store.applyCompaction('scope', 1, '摘要');
    await store.reset('scope');
    expect(await store.entries('scope')).toHaveLength(0);
    expect(await store.summary('scope')).toBeUndefined();
    // SummaryRounds counter is gone too
    const reloaded = new CompactStore(dir);
    expect(await reloaded.summary('scope')).toBeUndefined();
  });

  it('trims whitespace-heavy content and caps entry size', async () => {
    await store.appendUser('scope', '  a\n\n b  ');
    const entries = await store.entries('scope');
    expect(entries[0]?.text).toBe('a b');
    const huge = 'x'.repeat(20_000);
    await store.appendUser('scope', huge);
    const after = await store.entries('scope');
    expect(after[1]!.text.length).toBeLessThan(9_000);
  });

  it('ignores empty appends', async () => {
    await store.appendUser('scope', '   ');
    await store.appendAssistant('scope', '\n\n');
    expect(await store.entries('scope')).toHaveLength(0);
  });
});

describe('summarizeConversation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the OpenAI-compatible endpoint and returns the summary', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({
          choices: [{ message: { content: '这是压缩后的摘要。' } }],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await summarizeConversation({
      baseUrl: 'http://localhost:3000/v1/',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
      transcript: '用户：你好\n助手：你好',
    });
    expect(summary).toBe('这是压缩后的摘要。');

    const [url, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.messages[1]?.content).toContain('本次待压缩的对话记录');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('includes the old summary when provided', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '合并摘要' } }] }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await summarizeConversation({
      baseUrl: 'http://x',
      model: 'm',
      apiKey: 'k',
      oldSummary: '旧摘要',
      transcript: '新对话',
    });
    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [string, RequestInit];
    const content = (JSON.parse(String(init.body)) as { messages: Array<{ content: string }> })
      .messages[1]?.content as string;
    expect(content).toContain('已有的早期对话摘要');
    expect(content).toContain('旧摘要');
  });

  it('throws on non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'invalid key',
      }) as unknown as Response),
    );
    await expect(
      summarizeConversation({
        baseUrl: 'http://x',
        model: 'm',
        apiKey: 'bad',
        transcript: 't',
      }),
    ).rejects.toThrow(/401/);
  });

  it('throws on empty completions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' } }] }),
      }) as unknown as Response),
    );
    await expect(
      summarizeConversation({
        baseUrl: 'http://x',
        model: 'm',
        apiKey: 'k',
        transcript: 't',
      }),
    ).rejects.toThrow(/空内容/);
  });
});

describe('resolveCompactApiKey (homedir-scoped)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.doUnmock('node:os');
    vi.unstubAllEnvs();
    vi.resetModules();
    await Promise.all(
      cleanup.splice(0).map((d) =>
        rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('prefers the explicit configured key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'compact-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    vi.stubEnv('LOCAL_DEEPSEEK_API_KEY', 'env-key');
    const { resolveCompactApiKey } = await import('../../../src/session/compact-llm.js');
    await expect(resolveCompactApiKey('cfg-key')).resolves.toBe('cfg-key');
  });

  it('falls back to the env var', async () => {
    const home = await mkdtemp(join(tmpdir(), 'compact-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    vi.stubEnv('LOCAL_DEEPSEEK_API_KEY', 'env-key');
    const { resolveCompactApiKey } = await import('../../../src/session/compact-llm.js');
    await expect(resolveCompactApiKey()).resolves.toBe('env-key');
  });

  it('reads LOCAL_DEEPSEEK_API_KEY from ~/.hermes/.env', async () => {
    const home = await mkdtemp(join(tmpdir(), 'compact-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const hermesEnv = join(home, '.hermes', '.env');
    await import('node:fs/promises').then(async ({ mkdir }) => mkdir(join(home, '.hermes'), { recursive: true }));
    await writeFile(hermesEnv, 'FEISHU_APP_ID=cli_x\nLOCAL_DEEPSEEK_API_KEY="hermes-key"\n', 'utf8');
    const { resolveCompactApiKey } = await import('../../../src/session/compact-llm.js');
    await expect(resolveCompactApiKey()).resolves.toBe('hermes-key');
  });

  it('returns undefined when nothing is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'compact-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { resolveCompactApiKey } = await import('../../../src/session/compact-llm.js');
    await expect(resolveCompactApiKey()).resolves.toBeUndefined();
  });
});
