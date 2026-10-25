import { describe, it, expect } from 'vitest';
import { reduceTrace, type RunTrace } from './agents/trace-tree';
import type { TraceEvent } from './agents/trace-events';
import { summarizeTrace, formatSummary, subagentView } from './trace-summary';

function trace(events: TraceEvent[]): RunTrace {
  return events.reduce<RunTrace | null>((s, e) => reduceTrace(s, e), null)!;
}

const events: TraceEvent[] = [
  { type: 'run-start', runId: 'main', agent: 'main-chat', model: 'm', t: 0 },
  { type: 'span-start', id: 'main', kind: 'invoke_agent', name: 'main-chat', t: 0 },
  { type: 'span-start', id: 'main/mcp', parentId: 'main', kind: 'execute_tool', name: 'mcp.connect:saas', t: 0 },
  { type: 'span-end', id: 'main/mcp', t: 200, status: 'ok' },
  { type: 'span-start', id: 'main/step-1', parentId: 'main', kind: 'chat', name: 'chat m', t: 200 },
  { type: 'span-start', id: 'main/c1', parentId: 'main', kind: 'execute_tool', name: 'ask_saas', t: 900 },
  { type: 'span-end', id: 'main/step-1', t: 950, status: 'ok', usage: { input: 1000, output: 50 } },
  { type: 'span-start', id: 'main/c1:saas-agent:0', parentId: 'main/c1', kind: 'invoke_agent', name: 'saas-agent', t: 950 },
  { type: 'span-start', id: 'sub/chat', parentId: 'main/c1:saas-agent:0', kind: 'chat', name: 'chat m', t: 950 },
  { type: 'span-end', id: 'sub/chat', t: 3000, status: 'ok', usage: { input: 4000, output: 400 } },
  { type: 'span-start', id: 'sub/tool', parentId: 'main/c1:saas-agent:0', kind: 'execute_tool', name: 'tool_saas_sf_list_accounts', t: 3000 },
  { type: 'span-end', id: 'sub/tool', t: 4000, status: 'ok' },
  { type: 'span-end', id: 'main/c1:saas-agent:0', t: 6000, status: 'ok' },
  { type: 'span-end', id: 'main/c1', t: 6000, status: 'ok' },
  { type: 'span-start', id: 'main/step-2', parentId: 'main', kind: 'chat', name: 'chat m', t: 6000 },
  { type: 'span-end', id: 'main/step-2', t: 8400, status: 'ok', usage: { input: 923, output: 62 } },
  { type: 'span-end', id: 'main', t: 8400, status: 'ok' },
  { type: 'run-end', t: 8400, totalMs: 8400, ttftMs: 1200, usage: { input: 1923, output: 112 }, status: 'ok' },
];

describe('summarizeTrace', () => {
  it('counts model calls, tools and subagents across the whole tree', () => {
    expect(summarizeTrace(trace(events))).toEqual({
      totalMs: 8400,
      ttftMs: 1200,
      modelCalls: 3,
      toolCalls: 2,
      subagents: 1,
      inputTokens: 5923,
      outputTokens: 512,
    });
  });

  it('treats a run without an answer token as having no first-token time', () => {
    const t = trace([
      { type: 'run-start', runId: 'main', agent: 'main-chat', model: 'm', t: 0 },
      { type: 'run-end', t: 10, totalMs: 10, ttftMs: 0, usage: { input: 0, output: 0 }, status: 'error' },
    ]);
    expect(summarizeTrace(t).ttftMs).toBeNull();
  });
});

describe('formatSummary', () => {
  const s = { totalMs: 8400, ttftMs: 1200, modelCalls: 3, toolCalls: 2, subagents: 0, inputTokens: 5923, outputTokens: 512 };

  it('writes the zh-TW one-liner', () => {
    expect(formatSummary(s, 'zh-TW')).toBe('共 8.4 秒 · 首字 1.2 秒 · 3 次模型呼叫 · 2 個工具 · 輸入 5,923 / 輸出 512 tokens');
  });

  it('mentions subagents and drops a missing first-token time', () => {
    expect(formatSummary({ ...s, ttftMs: null, subagents: 1 }, 'zh-TW')).toBe(
      '共 8.4 秒 · 3 次模型呼叫 · 2 個工具 · 1 個 subagent · 輸入 5,923 / 輸出 512 tokens',
    );
  });

  it('writes English', () => {
    expect(formatSummary(s, 'en')).toBe('8.4 s total · first token 1.2 s · 3 model calls · 2 tools · 5,923 in / 512 out tokens');
  });
});

describe('subagentView', () => {
  it('summarizes the subagent under a delegate tool call', () => {
    const v = subagentView(trace(events), 'c1', 7000);
    expect(v).toEqual({
      running: false,
      durationMs: 5050,
      inputTokens: 4000,
      outputTokens: 400,
      modelCalls: 1,
      tools: [{ name: 'tool_saas_sf_list_accounts', status: 'done', durationMs: 1000 }],
      tail: '',
    });
  });

  it('shows live progress and the latest text while running', () => {
    const live = trace([
      ...events.slice(0, 9),
      { type: 'text-delta', spanId: 'sub/chat', text: 'Looking up accounts' },
    ]);
    expect(subagentView(live, 'c1', 2000)).toMatchObject({ running: true, durationMs: 1050, tail: 'Looking up accounts' });
  });

  it('returns null before the subagent starts', () => {
    expect(subagentView(trace(events.slice(0, 6)), 'c1', 1000)).toBeNull();
  });
});
