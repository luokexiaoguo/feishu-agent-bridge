import { describe, expect, it } from 'vitest';
import { buildOpencodeArgs } from '../../../src/agent/opencode/argv.js';

describe('buildOpencodeArgs', () => {
  it('builds a minimal fresh run with the prompt as positional arg', () => {
    expect(buildOpencodeArgs({ cwd: '/work' })).toEqual(['run', '--format', 'json', '--dir', '/work']);
  });

  it('forwards session, model, thinking, and permissions', () => {
    expect(
      buildOpencodeArgs({
        cwd: '/work',
        sessionId: 'ses_abc',
        model: 'opencode/zen',
        thinking: true,
        skipPermissions: true,
      }),
    ).toEqual([
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions',
      '--thinking',
      '--model',
      'opencode/zen',
      '--session',
      'ses_abc',
      '--dir',
      '/work',
    ]);
  });

  it('omits thinking when false and skipPermissions when false', () => {
    expect(
      buildOpencodeArgs({ cwd: '/work', thinking: false, skipPermissions: false }),
    ).toEqual(['run', '--format', 'json', '--dir', '/work']);
  });
});
