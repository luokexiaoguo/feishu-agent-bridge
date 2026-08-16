import { describe, expect, it, vi } from 'vitest';
import { MEETING_DEFAULTS } from '../../../src/config/profile-schema';
import { MeetingManager, VC_BOT_EVENTS } from '../../../src/meeting/manager';
import type { VcRequestClient } from '../../../src/meeting/api';

type Handler = (data: unknown) => unknown;

function fakeChannel(): { channel: unknown; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    channel: {
      dispatcher: {
        register(map: Record<string, Handler>) {
          for (const [k, v] of Object.entries(map)) handlers.set(k, v);
        },
      },
    },
  };
}

/** Hands out a distinct long meeting id per join, keyed by meeting number. */
function multiJoinClient(map: Record<string, string>): {
  client: VcRequestClient;
  sent: { url: string; body: Record<string, unknown> }[];
} {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  return {
    sent,
    client: {
      request: vi.fn(async (p: { url: string; data?: unknown }) => {
        const body = (p.data ?? {}) as Record<string, unknown>;
        sent.push({ url: p.url, body });
        if (p.url.endsWith('/join')) {
          const identify = body.join_identify as { meeting_no?: string } | undefined;
          const no = identify?.meeting_no ?? '';
          return { code: 0, data: { meeting: { id: map[no] ?? 'unknown' } } } as never;
        }
        return { code: 0, data: {} } as never;
      }),
    },
  };
}

function transcriptPush(meetingId: string, eventId: string, text: string) {
  return {
    meeting_activity_items: [
      {
        event_id: eventId,
        meeting: { id: meetingId },
        activity_event_type: 'transcript_received',
        transcript_received_items: [{ sentence_id: eventId, text, speaker: { name: '甲' } }],
      },
    ],
  };
}

describe('one bot across several meetings', () => {
  it('keeps each meeting transcript isolated', async () => {
    const { channel, handlers } = fakeChannel();
    const { client } = multiJoinClient({ '111111111': 'm-A', '222222222': 'm-B' });
    const m = new MeetingManager({ client, config: () => ({ ...MEETING_DEFAULTS, enabled: true }), channel });
    m.attachPush();

    const a = await m.join('111111111');
    const b = await m.join('222222222');
    expect(m.list()).toHaveLength(2);

    handlers.get(VC_BOT_EVENTS.activity)?.(transcriptPush('m-A', 'a1', 'A 会的内容'));
    handlers.get(VC_BOT_EVENTS.activity)?.(transcriptPush('m-B', 'b1', 'B 会的内容'));

    // No cross-talk: each session only ever sees its own meeting.
    expect(a.recentTranscript()).toEqual(['甲: A 会的内容']);
    expect(b.recentTranscript()).toEqual(['甲: B 会的内容']);
  });

  it('answers back into the meeting that asked, not the other one', async () => {
    const { client, sent } = multiJoinClient({ '111111111': 'm-A', '222222222': 'm-B' });
    const m = new MeetingManager({ client, config: () => ({ ...MEETING_DEFAULTS, enabled: true }), channel: fakeChannel().channel });
    const a = await m.join('111111111');
    await m.join('222222222');

    await a.sendMessage('只发给 A 会');

    const messages = sent.filter((c) => c.url.endsWith('/message'));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body.meeting_id).toBe('m-A');
  });

  it('leaves only the requested meeting', async () => {
    const { client, sent } = multiJoinClient({ '111111111': 'm-A', '222222222': 'm-B' });
    const m = new MeetingManager({ client, config: () => ({ ...MEETING_DEFAULTS, enabled: true }), channel: fakeChannel().channel });
    await m.join('111111111');
    const b = await m.join('222222222');

    await m.leave(b.meetingId);

    expect(m.list().map((s) => s.meetingNo)).toEqual(['111111111']);
    const leaves = sent.filter((c) => c.url.endsWith('/leave'));
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.body.meeting_id).toBe('m-B');
  });

  it('ends only the meeting that reported ended', async () => {
    const { channel, handlers } = fakeChannel();
    const { client } = multiJoinClient({ '111111111': 'm-A', '222222222': 'm-B' });
    const m = new MeetingManager({ client, config: () => ({ ...MEETING_DEFAULTS, enabled: true }), channel });
    m.attachPush();
    const a = await m.join('111111111');
    const b = await m.join('222222222');

    handlers.get(VC_BOT_EVENTS.ended)?.({ meeting: { id: 'm-A' } });

    expect(a.ended).toBe(true);
    expect(b.ended).toBe(false);
    expect(m.list().map((s) => s.meetingNo)).toEqual(['222222222']);
  });

  it('finds a session by meeting number so commands can disambiguate', async () => {
    const { client } = multiJoinClient({ '111111111': 'm-A', '222222222': 'm-B' });
    const m = new MeetingManager({ client, config: () => ({ ...MEETING_DEFAULTS, enabled: true }), channel: fakeChannel().channel });
    await m.join('111111111');
    await m.join('222222222');

    expect(m.byMeetingNo('222222222')?.meetingId).toBe('m-B');
    expect(m.byMeetingNo(' 111111111 ')?.meetingId).toBe('m-A');
    expect(m.byMeetingNo('999999999')).toBeUndefined();
  });

  it('binds a session to the chat it was joined from, for command targeting', async () => {
    const { client } = multiJoinClient({ '111111111': 'm-A', '222222222': 'm-B' });
    const m = new MeetingManager({ client, config: () => ({ ...MEETING_DEFAULTS, enabled: true }), channel: fakeChannel().channel });
    const a = await m.join('111111111', { originChatId: 'oc_team' });
    const b = await m.join('222222222', { originChatId: 'oc_other' });

    expect(a.originChatId).toBe('oc_team');
    expect(b.originChatId).toBe('oc_other');
  });
});
