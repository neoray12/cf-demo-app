import { describe, it, expect } from 'vitest';
import { createChatSpanTracker, MAIN_ROOT_SPAN } from './chat-spans';
import type { TraceEvent } from './agents/trace-events';

const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output });

function run(parts: Array<[number, Record<string, unknown>]>) {
  const tracker = createChatSpanTracker({ model: 'anthropic/claude-haiku-5-5', traced: false });
  const events: TraceEvent[] = [...tracker.start(0)];
  for (const [t, part] of parts) events.push(...tracker.onPart(part as { type: string }, t));
  return { tracker, events };
}

describe('createChatSpanTracker', () => {
  it('turns a tool step and an answer step into nested spans with usage', () => {
    const gateway = { logId: 'log-1', cacheStatus: 'MISS', ray: 'ray-1', routedModel: null };
    const tracker = createChatSpanTracker({ model: 'anthropic/claude-haiku-5-5', traced: true });
    const events: TraceEvent[] = [...tracker.start(0)];
    const feed = (t: number, part: Record<string, unknown>, gw?: typeof gateway) => events.push(...tracker.onPart(part as { type: string }, t, gw));
    feed(10, { type: 'start-step' });
    feed(400, { type: 'tool-input-start', id: 'c1', toolName: 'readWebPage' });
    feed(420, { type: 'tool-call', toolCallId: 'c1', toolName: 'readWebPage', input: { url: 'https://example.com' } });
    feed(450, { type: 'finish-step', usage: usage(100, 20), finishReason: 'tool-calls' }, gateway);
    feed(900, { type: 'tool-result', toolCallId: 'c1', toolName: 'readWebPage', output: { markdown: 'x' } });
    feed(910, { type: 'start-step' });
    feed(1200, { type: 'text-delta', text: 'Hi' });
    feed(1300, { type: 'finish-step', usage: usage(300, 40), finishReason: 'stop' });
    events.push(...tracker.end(1310, 'ok'));

    expect(events.map((e) => `${e.type}:${'id' in e ? e.id : ''}`)).toEqual([
      'run-start:',
      `span-start:${MAIN_ROOT_SPAN}`,
      'span-start:main/step-1',
      'span-start:main/c1',
      'span-input:main/c1',
      'span-end:main/step-1',
      'span-end:main/c1',
      'span-start:main/step-2',
      'span-end:main/step-2',
      `span-end:${MAIN_ROOT_SPAN}`,
      'run-end:',
    ]);
    expect(events[0]).toMatchObject({ type: 'run-start', agent: 'main-chat', model: 'anthropic/claude-haiku-5-5', traced: true });
    expect(events.find((e) => e.type === 'span-start' && e.id === 'main/c1')).toMatchObject({ parentId: MAIN_ROOT_SPAN, kind: 'execute_tool', name: 'readWebPage' });
    expect(events.find((e) => e.type === 'span-end' && e.id === 'main/step-1')).toMatchObject({
      usage: { input: 100, output: 20 },
      detail: { finishReason: 'tool-calls', gateway },
    });
    expect(events.find((e) => e.type === 'span-end' && e.id === 'main/step-2')).toMatchObject({ usage: { input: 300, output: 40 }, ttftMs: 290 });
    expect(tracker.usage()).toEqual({ input: 400, output: 60 });
    expect(events.at(-1)).toMatchObject({ type: 'run-end', totalMs: 1310, ttftMs: 1200, usage: { input: 400, output: 60 }, status: 'ok' });
  });

  it('marks a blocked tool result', () => {
    const { events } = run([
      [1, { type: 'start-step' }],
      [2, { type: 'tool-input-start', id: 'b', toolName: 'ask_saas' }],
      [3, { type: 'tool-result', toolCallId: 'b', toolName: 'ask_saas', output: { blocked: true } }],
    ]);
    expect(events.find((e) => e.type === 'span-end' && e.id === 'main/b')).toMatchObject({ status: 'ok', detail: { blocked: true } });
  });

  it('closes every open span, innermost first, when the user stops', () => {
    const { tracker, events } = run([
      [1, { type: 'start-step' }],
      [2, { type: 'tool-input-start', id: 'slow', toolName: 'ask_saas' }],
    ]);
    const closing = tracker.end(50, 'aborted');
    expect(closing.map((e) => `${e.type}:${'id' in e ? e.id : ''}:${'status' in e ? e.status : ''}`)).toEqual([
      'span-end:main/slow:error',
      'span-end:main/step-1:error',
      `span-end:${MAIN_ROOT_SPAN}:error`,
      'run-end::aborted',
    ]);
    expect(events.length).toBeGreaterThan(0);
  });

  it('opens a tool span only once', () => {
    const { events } = run([
      [1, { type: 'start-step' }],
      [2, { type: 'tool-input-start', id: 'x', toolName: 't' }],
      [3, { type: 'tool-input-start', id: 'x', toolName: 't' }],
      [4, { type: 'tool-call', toolCallId: 'x', toolName: 't', input: {} }],
    ]);
    expect(events.filter((e) => e.type === 'span-start' && e.id === 'main/x')).toHaveLength(1);
  });
});
