import { describe, expect, it } from 'vitest';
import { translateUpdate } from '../../../src/agent/hermes/adapter.js';

describe('hermes ACP update translation', () => {
  it('translates agent_thought_chunk to thinking deltas', () => {
    expect(
      translateUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me think' } }),
    ).toEqual([{ type: 'thinking', delta: 'Let me think' }]);
  });

  it('translates agent_message_chunk to text deltas', () => {
    expect(
      translateUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答案来了' } }),
    ).toEqual([{ type: 'text', delta: '答案来了' }]);
  });

  it('translates tool_call to tool_use', () => {
    expect(
      translateUpdate({
        sessionUpdate: 'tool_call',
        kind: 'execute',
        toolCallId: 'tc-1',
        title: 'terminal: echo hi',
        content: [{ content: { text: '$ echo hi', type: 'text' }, type: 'content' }],
      }),
    ).toEqual([
      { type: 'tool_use', id: 'tc-1', name: 'execute', input: [{ content: { text: '$ echo hi', type: 'text' }, type: 'content' }] },
    ]);
  });

  it('translates a completed tool_call_update to tool_result with output', () => {
    expect(
      translateUpdate({
        sessionUpdate: 'tool_call_update',
        kind: 'execute',
        status: 'completed',
        toolCallId: 'tc-1',
        content: [{ content: { text: 'terminal result\n- **output:** hi\n- **exit_code:** 0', type: 'text' }, type: 'content' }],
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'tc-1',
        output: 'terminal result\n- **output:** hi\n- **exit_code:** 0',
        isError: false,
      },
    ]);
  });

  it('marks non-completed tool results as errors', () => {
    expect(
      translateUpdate({
        sessionUpdate: 'tool_call_update',
        status: 'error',
        toolCallId: 'tc-2',
        content: { content: { text: 'boom', type: 'text' }, type: 'content' },
      }),
    ).toEqual([{ type: 'tool_result', id: 'tc-2', output: 'boom', isError: true }]);
  });

  it('extracts single-object text from tool results', () => {
    expect(
      translateUpdate({
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        toolCallId: 'tc-3',
        content: { content: { text: 'single', type: 'text' }, type: 'content' },
      }),
    ).toEqual([{ type: 'tool_result', id: 'tc-3', output: 'single', isError: false }]);
  });

  it('ignores usage / session-info / command-list updates', () => {
    expect(translateUpdate({ sessionUpdate: 'usage_update', size: 100, used: 10 })).toEqual([]);
    expect(translateUpdate({ sessionUpdate: 'session_info_update', title: 'x' })).toEqual([]);
    expect(translateUpdate({ availableCommands: [] })).toEqual([]);
    expect(translateUpdate({})).toEqual([]);
  });
});
