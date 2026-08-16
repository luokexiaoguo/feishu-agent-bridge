import { describe, expect, it, vi } from 'vitest';
import {
  checkMeetingPreflight,
  classifyPreflight,
  MEETING_REQUIRED_EVENTS,
  MEETING_REQUIRED_SCOPES,
  type PreflightExec,
} from '../../../src/meeting/preflight';

/** The exact error lark-cli returns when the app identity lacks the scope. */
const SCOPE_ERROR = {
  ok: false,
  identity: 'bot',
  error: {
    type: 'authorization',
    subtype: 'app_scope_not_applied',
    code: 99991672,
    message: 'access denied for bot identity; recommended scope: vc:meeting.bot.join:write',
    hint: 'ask the app developer to enable scope vc:meeting.bot.join:write',
    missing_scopes: ['vc:meeting.bot.join:write'],
    console_url:
      'https://open.feishu.cn/page/scope-apply?clientID=cli_a9408afb4c781cb3&scopes=vc%3Ameeting.bot.join%3Awrite',
  },
};

describe('classifyPreflight', () => {
  it('extracts missing scopes and the scope-apply URL verbatim', () => {
    const r = classifyPreflight(SCOPE_ERROR);
    expect(r.status).toBe('scope-missing');
    expect(r.missingScopes).toEqual(['vc:meeting.bot.join:write']);
    // Opaque URL: must survive byte-for-byte (no re-encoding of %3A etc).
    expect(r.consoleUrl).toBe(SCOPE_ERROR.error.console_url);
    expect(r.requiredEvents).toEqual(MEETING_REQUIRED_EVENTS);
    // The probe trips on one scope, but the console must show all of them:
    // joining succeeds with bot.join:write alone, then sending fails on
    // message:write — that two-step surprise is what this prevents.
    expect(r.requiredScopes.map((x) => x.scope)).toEqual([
      'vc:meeting.bot.join:write',
      'vc:meeting.message:write',
      'vc:meeting.meetingevent:read',
    ]);
    expect(r.requiredScopes).toEqual(MEETING_REQUIRED_SCOPES);
  });

  it('treats a successful probe as ready', () => {
    const r = classifyPreflight({ ok: true, identity: 'bot', data: { meetings: [] } });
    expect(r.status).toBe('ok');
    expect(r.missingScopes).toEqual([]);
  });

  it('detects the allowlisted beta gate and offers the sign-up link', () => {
    const byCode = classifyPreflight({ ok: false, error: { code: 20017, message: 'ErrNotInGray' } });
    expect(byCode.status).toBe('not-in-beta');
    expect(byCode.betaChatUrl).toMatch(/join-chat/);

    const byMessage = classifyPreflight({ ok: false, error: { code: 1, message: 'ErrNotInGray' } });
    expect(byMessage.status).toBe('not-in-beta');
  });

  it('falls back to unknown for unrecognized failures, keeping the message', () => {
    const r = classifyPreflight({ ok: false, error: { code: 12345, message: 'weird' } });
    expect(r.status).toBe('unknown');
    expect(r.message).toBe('weird');
  });

  it('does not crash on garbage', () => {
    expect(classifyPreflight(undefined).status).toBe('unknown');
    expect(classifyPreflight('nope').status).toBe('unknown');
  });
});

describe('checkMeetingPreflight', () => {
  it('runs a read-only bot probe and passes the probe user id through', async () => {
    const calls: string[][] = [];
    const exec: PreflightExec = vi.fn(async (args) => {
      calls.push(args);
      return { code: 1, stdout: JSON.stringify(SCOPE_ERROR), stderr: '' };
    });

    const r = await checkMeetingPreflight({ profile: 'claude', probeUserId: 'ou_owner' }, exec);

    expect(calls[0]).toEqual([
      'vc', '+meeting-list-active', '--as', 'bot', '--json', '--user-id', 'ou_owner',
    ]);
    expect(r.status).toBe('scope-missing');
    expect(r.consoleUrl).toBe(SCOPE_ERROR.error.console_url);
  });

  it('reports unknown (not a throw) when lark-cli produces no JSON', async () => {
    const exec: PreflightExec = vi.fn(async () => ({
      code: 127,
      stdout: '',
      stderr: 'lark-cli: command not found',
    }));
    const r = await checkMeetingPreflight({ profile: 'claude' }, exec);
    expect(r.status).toBe('unknown');
    expect(r.message).toMatch(/command not found/);
  });

  it('reads the error envelope off stderr too', async () => {
    const exec: PreflightExec = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: JSON.stringify(SCOPE_ERROR),
    }));
    expect((await checkMeetingPreflight({ profile: 'claude' }, exec)).status).toBe('scope-missing');
  });
});
