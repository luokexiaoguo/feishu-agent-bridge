import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runNativeCompact, compactOpenClawSession } from '../../../src/session/compact-llm.js';
import type { AgentAdapter, AgentRunOptions } from '../../../src/agent/types.js';

describe('runNativeCompact', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function adapterWith(
    events: import('../../../src/agent/types.js').AgentEvent[],
    onRun?: (o: AgentRunOptions) => void,
  ): AgentAdapter {
    return {
      id: 'claude',
      displayName: 'Claude Code',
      isAvailable: async () => true,
      run: (o) => {
        onRun?.(o);
        return {
          runId: o.runId,
          events: (async function* () {
            for (const evt of events) yield evt;
          })(),
          stop: async () => {},
          waitForExit: async () => true,
        };
      },
    };
  }

  it('dispatches the command against the resumed session', async () => {
    let captured: AgentRunOptions | undefined;
    const adapter = adapterWith([{ type: 'done', terminationReason: 'normal' }], (o) => (captured = o));
    await expect(
      runNativeCompact({ adapter, sessionId: 'sess-1', command: '/compact', cwd: '/tmp' }),
    ).resolves.toBe(true);
    expect(captured?.prompt).toBe('/compact');
    expect(captured?.sessionId).toBe('sess-1');
    expect(captured?.cwd).toBe('/tmp');
  });

  it('forwards focus instructions verbatim', async () => {
    let captured: AgentRunOptions | undefined;
    const adapter = adapterWith([{ type: 'done', terminationReason: 'normal' }], (o) => (captured = o));
    await runNativeCompact({ adapter, sessionId: 's', command: '/compact focus on auth' });
    expect(captured?.prompt).toBe('/compact focus on auth');
  });

  it('throws when the run reports an error', async () => {
    const adapter = adapterWith([
      { type: 'error', message: 'claude exited with code 1', terminationReason: 'failed' },
    ]);
    await expect(
      runNativeCompact({ adapter, sessionId: 's', command: '/compact' }),
    ).rejects.toThrow(/claude exited with code 1/);
  });

  it('stops the run and throws on timeout', async () => {
    vi.useFakeTimers();
    let stopped = false;
    const adapter: AgentAdapter = {
      id: 'mimo',
      displayName: 'MiMo Code',
      isAvailable: async () => true,
      run: () => ({
        runId: 'x',
        events: (async function* () {
          while (true) {
            await new Promise((r) => setTimeout(r, 60_000));
            yield { type: 'text', delta: 'still going' };
          }
        })(),
        stop: async () => {
          stopped = true;
        },
        waitForExit: async () => false,
      }),
    };
    const promise = runNativeCompact({ adapter, sessionId: 's', command: '/compact', timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(stopped).toBe(true);
  });
});

describe('compactOpenClawSession (real fake binary)', () => {
  const cleanup: string[] = [];

  async function fakeOpenClaw(behavior: {
    list: string;
    listCode?: number;
    compactStdout?: string;
    compactCode?: number;
  }): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oc-fake-'));
    cleanup.push(dir);
    const bin = join(dir, 'openclaw');
    const script = `#!/bin/bash
if [ "$1" = "sessions" ] && [ "$2" = "list" ]; then
  printf '%s' '${behavior.list}'
  exit ${behavior.listCode ?? 0}
fi
if [ "$1" = "sessions" ] && [ "$2" = "compact" ]; then
  printf '%s' '${behavior.compactStdout ?? 'Compacted session.'}'
  exit ${behavior.compactCode ?? 0}
fi
exit 1
`;
    await writeFile(bin, script, 'utf8');
    await chmod(bin, 0o755);
    return bin;
  }

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
    );
  });

  it('resolves the session key and runs sessions compact', async () => {
    const bin = await fakeOpenClaw({
      list: JSON.stringify([
        { key: 'agent:main:feishu:direct:ou_abc', sessionId: 'sys-111' },
        { key: 'agent:main:main', sessionId: 'sys-222' },
      ]),
    });
    await expect(
      compactOpenClawSession({ binary: bin, agentId: 'main', sessionId: 'sys-222' }),
    ).resolves.toBe(true);
  });

  it('throws when the session cannot be found', async () => {
    const bin = await fakeOpenClaw({
      list: JSON.stringify([{ key: 'agent:main:main', sessionId: 'other' }]),
    });
    await expect(
      compactOpenClawSession({ binary: bin, agentId: 'main', sessionId: 'missing' }),
    ).rejects.toThrow(/找不到 openclaw 会话/);
  });

  it('treats "already compacted" as success', async () => {
    const bin = await fakeOpenClaw({
      list: JSON.stringify([{ key: 'agent:main:main', sessionId: 's' }]),
      compactCode: 1,
      compactStdout: 'Compaction failed for session agent:main:main: Already compacted.',
    });
    await expect(
      compactOpenClawSession({ binary: bin, agentId: 'main', sessionId: 's' }),
    ).resolves.toBe(true);
  });
});
