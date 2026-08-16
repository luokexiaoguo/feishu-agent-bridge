import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';

const cleanups: Array<() => Promise<void>> = [];

describe('CodexAdapter prepareRun', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('allows a run when the configured Codex binary returns a version without stored metadata', async () => {
    const binary = await writeCodexBinary('codex 1.2.3');
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(adapter.prepareRun()).resolves.toBeUndefined();
  });

  it('reports a preflight diagnostic when the configured Codex binary is missing', async () => {
    const adapter = new CodexAdapter({
      binary: join(tmpdir(), 'missing-codex'),
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(adapter.prepareRun()).rejects.toMatchObject({
      code: 'agent-binary-not-found',
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'codex',
        agentName: 'Codex CLI',
      },
    });
  });
});

async function writeCodexBinary(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-prepare-run-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return writeVersionExecutable(dir, 'codex', version);
}
