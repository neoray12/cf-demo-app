import { describe, it, expect } from 'vitest';
import { applyChatEvent, createTurnState, type ChatStreamEvent } from './chat-turn';

function fold(events: Array<[number, ChatStreamEvent]>) {
  return events.reduce((s, [t, ev]) => applyChatEvent(s, ev, t), createTurnState());
}

describe('applyChatEvent', () => {
  it('keeps reasoning → tool → text in the order it happened', () => {
    const s = fold([
      [10, { type: 'reasoning-delta', text: 'think ' }],
      [12, { type: 'reasoning-delta', text: 'more' }],
      [20, { type: 'tool-call-start', toolCallId: 'c1', toolName: 'executeJs' }],
      [25, { type: 'tool-call', toolCallId: 'c1', toolName: 'executeJs', args: { code: '1+1' } }],
      [40, { type: 'tool-result', toolCallId: 'c1', toolName: 'executeJs', result: { result: 2 } }],
      [50, { type: 'text-delta', text: 'The answer ' }],
      [51, { type: 'text-delta', text: 'is 2.' }],
    ]);
    expect(s.parts).toEqual([
      { type: 'reasoning', text: 'think more' },
      { type: 'tool', id: 'c1' },
      { type: 'text', text: 'The answer is 2.' },
    ]);
    expect(s.content).toBe('The answer is 2.');
    expect(s.reasoning).toBe('think more');
    expect(s.toolCalls).toEqual([{ id: 'c1', name: 'executeJs', status: 'done', args: { code: '1+1' }, result: { result: 2 } }]);
    expect(s.events).toEqual([
      { t: 10, kind: 'reasoning' },
      { t: 20, kind: 'tool-start', id: 'c1', name: 'executeJs' },
      { t: 40, kind: 'tool-end', id: 'c1', outcome: 'done' },
      { t: 50, kind: 'text' },
    ]);
  });

  it('creates a tool from tool-call without tool-call-start, and records errors and blocks', () => {
    const s = fold([
      [5, { type: 'tool-call', toolCallId: 'a', toolName: 'x', args: {} }],
      [6, { type: 'tool-error', toolCallId: 'a', toolName: 'x', error: 'boom' }],
      [7, { type: 'tool-call-start', toolCallId: 'b', toolName: 'mcp' }],
      [8, { type: 'tool-call-start', toolCallId: 'b', toolName: 'mcp' }],
      [9, { type: 'tool-result', toolCallId: 'b', toolName: 'mcp', result: { blocked: true } }],
    ]);
    expect(s.toolCalls.map((tc) => [tc.id, tc.status, tc.error])).toEqual([
      ['a', 'error', 'boom'],
      ['b', 'done', undefined],
    ]);
    expect(s.parts).toEqual([{ type: 'tool', id: 'a' }, { type: 'tool', id: 'b' }]);
    expect(s.events.filter((e) => e.kind === 'tool-end')).toEqual([
      { t: 6, kind: 'tool-end', id: 'a', outcome: 'error' },
      { t: 9, kind: 'tool-end', id: 'b', outcome: 'blocked' },
    ]);
  });

  it('records routed model and de-duplicated notices, ignores unknown events', () => {
    const s = fold([
      [1, { type: 'routed-model', model: 'anthropic/claude-haiku-5-5', reason: 'cheap' }],
      [2, { type: 'notice', kind: 'portal-codemode' }],
      [3, { type: 'notice', kind: 'portal-codemode' }],
      [4, { type: 'finish', finishReason: 'stop' }],
      [5, { type: 'text-delta', text: '' }],
    ]);
    expect(s.routedModel).toEqual({ model: 'anthropic/claude-haiku-5-5', reason: 'cheap' });
    expect(s.notices).toEqual(['portal-codemode']);
    expect(s.parts).toEqual([]);
    expect(s.events).toEqual([]);
  });
});
