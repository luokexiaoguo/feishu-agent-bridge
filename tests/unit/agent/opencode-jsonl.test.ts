import { describe, expect, it } from 'vitest';
import { OpencodeJsonlTranslator } from '../../../src/agent/opencode/jsonl.js';

describe('OpencodeJsonlTranslator', () => {
  it('captures sessionId from the first event and emits a system event once', () => {
    const t = new OpencodeJsonlTranslator();
    expect(t.translate({ type: 'step_start', sessionID: 'ses_a', part: { type: 'step-start' } })).toEqual([
      { type: 'system', sessionId: 'ses_a' },
    ]);
    expect(t.translate({ type: 'step_start', sessionID: 'ses_a', part: { type: 'step-start' } })).toEqual([]);
  });

  it('translates text blocks to text deltas', () => {
    const t = new OpencodeJsonlTranslator();
    expect(t.translate({ type: 'text', sessionID: 'ses_a', part: { type: 'text', text: '你好世界' } })).toEqual([
      { type: 'system', sessionId: 'ses_a' },
      { type: 'text', delta: '你好世界' },
    ]);
  });

  it('translates reasoning to thinking', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'step_start', sessionID: 'ses_a' });
    expect(t.translate({ type: 'reasoning', sessionID: 'ses_a', part: { type: 'reasoning', text: '思考中' } })).toEqual([
      { type: 'thinking', delta: '思考中' },
    ]);
  });

  it('resolves a completed tool call to tool_use + tool_result', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'step_start', sessionID: 'ses_a' });
    const events = t.translate({
      type: 'tool_use',
      sessionID: 'ses_a',
      part: {
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\n', title: 'echo hi' },
      },
    });
    expect(events).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'echo hi' } },
      { type: 'tool_result', id: 'call_1', output: 'hi\n', isError: false },
    ]);
  });

  it('marks failed tools as errors with the error payload', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'step_start', sessionID: 'ses_a' });
    const events = t.translate({
      type: 'tool_use',
      sessionID: 'ses_a',
      part: {
        type: 'tool',
        callID: 'call_2',
        tool: 'bash',
        state: { status: 'error', input: { command: 'nope' }, error: 'command not found' },
      },
    });
    expect(events[1]).toEqual({
      type: 'tool_result',
      id: 'call_2',
      output: 'command not found',
      isError: true,
    });
  });

  it('maps step_finish tokens to a usage event', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'step_start', sessionID: 'ses_a' });
    const events = t.translate({
      type: 'step_finish',
      sessionID: 'ses_a',
      part: { type: 'step-finish', tokens: { input: 100, output: 50, cost: 0.012 } },
    });
    expect(events).toEqual([
      { type: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.012 },
    ]);
  });

  it('emits error events with the API message', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'step_start', sessionID: 'ses_a' });
    const events = t.translate({
      type: 'error',
      sessionID: 'ses_a',
      error: { name: 'APIError', data: { message: 'Insufficient balance' } },
    });
    expect(events).toEqual([
      { type: 'error', message: 'Insufficient balance', terminationReason: 'failed' },
    ]);
    // terminal already emitted -> finish() is a no-op
    expect(t.finish('normal')).toEqual([]);
  });

  it('finish() emits done with the captured sessionId when nothing terminal arrived', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'step_start', sessionID: 'ses_a' });
    expect(t.finish('normal')).toEqual([
      { type: 'done', sessionId: 'ses_a', terminationReason: 'normal' },
    ]);
    expect(t.finish('normal')).toEqual([]);
  });
});
