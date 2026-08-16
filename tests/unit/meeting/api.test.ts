import { describe, expect, it, vi } from 'vitest';
import {
  fetchMeetingEvents,
  isMeetingNo,
  joinMeeting,
  leaveMeeting,
  sendMeetingText,
  VcApiError,
  type VcRequestClient,
} from '../../../src/meeting/api';

interface Call {
  method: string;
  url: string;
  data?: unknown;
  params?: Record<string, unknown>;
}

/** Records requests and returns a canned envelope. */
function fakeClient(reply: unknown): { client: VcRequestClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      request: vi.fn(async (payload: Call) => {
        calls.push(payload);
        return reply as never;
      }),
    },
  };
}

describe('meeting REST layer', () => {
  it('validates the 9-digit meeting number', () => {
    expect(isMeetingNo('123456789')).toBe(true);
    expect(isMeetingNo(' 123456789 ')).toBe(true);
    expect(isMeetingNo('12345678')).toBe(false); // 8 digits
    expect(isMeetingNo('1234567890')).toBe(false); // 10 digits
    expect(isMeetingNo('12345678a')).toBe(false);
    expect(isMeetingNo('https://vc.feishu.cn/j/123456789')).toBe(false);
  });

  it('joins with join_type=1 and returns the long meeting id', async () => {
    const { client, calls } = fakeClient({ code: 0, data: { meeting: { id: '70001', topic: '周会' } } });

    const joined = await joinMeeting(client, { meetingNo: '123456789' });

    expect(joined).toEqual({ meetingId: '70001', meetingNo: '123456789', topic: '周会' });
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/open-apis/vc/v1/bots/join',
      data: { join_type: 1, join_identify: { meeting_no: '123456789' } },
    });
  });

  it('refuses a non-9-digit meeting number before calling the API', async () => {
    const { client, calls } = fakeClient({ code: 0, data: {} });
    await expect(joinMeeting(client, { meetingNo: '7000123456789' })).rejects.toThrow(/9 位数字/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a non-zero code as VcApiError and flags the beta gate (20017)', async () => {
    const gray = fakeClient({ code: 20017, msg: 'ErrNotInGray' });
    const err = await joinMeeting(gray.client, { meetingNo: '123456789' }).catch((e) => e);
    expect(err).toBeInstanceOf(VcApiError);
    expect((err as VcApiError).notInGray).toBe(true);

    const other = fakeClient({ code: 1050000, msg: 'boom' });
    const err2 = await leaveMeeting(other.client, '70001').catch((e) => e);
    expect((err2 as VcApiError).code).toBe(1050000);
    expect((err2 as VcApiError).notInGray).toBe(false);
  });

  it('sends an in-meeting text message', async () => {
    const { client, calls } = fakeClient({ code: 0, data: {} });
    await sendMeetingText(client, '70001', '已记录');
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/open-apis/vc/v1/bots/message',
      data: { meeting_id: '70001', msg_type: 'text', content: '已记录' },
    });
  });

  it('puts event query args in params (GET bodies are dropped) and reads the cursor', async () => {
    const { client, calls } = fakeClient({
      code: 0,
      data: { events: [{ event_id: 'e1' }], page_token: 'tok-2', has_more: true },
    });

    const page = await fetchMeetingEvents(client, { meetingId: '70001', pageToken: 'tok-1' });

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.data).toBeUndefined();
    expect(calls[0]?.params).toEqual({ meeting_id: '70001', page_size: 100, page_token: 'tok-1' });
    expect(page.items).toHaveLength(1);
    expect(page.pageToken).toBe('tok-2');
    expect(page.hasMore).toBe(true);
  });

  it('tolerates the alternate items field and an empty cursor', async () => {
    const { client } = fakeClient({
      code: 0,
      data: { meeting_activity_items: [{ event_id: 'e1' }, { event_id: 'e2' }], page_token: '' },
    });
    const page = await fetchMeetingEvents(client, { meetingId: '70001' });
    expect(page.items).toHaveLength(2);
    expect(page.pageToken).toBeUndefined();
    expect(page.hasMore).toBe(false);
  });
});
