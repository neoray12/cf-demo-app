import { describe, it, expect } from 'vitest';
import { reduceTrace, type RunTrace } from './agents/trace-tree';
import type { TraceEvent } from './agents/trace-events';
import { partialJsonString, parseCodeResult, subagentSteps } from './subagent-steps';

function trace(events: TraceEvent[]): RunTrace {
  return events.reduce<RunTrace | null>((s, e) => reduceTrace(s, e), null)!;
}

const AGENT = 'main/c1:saas-agent:0';
const EXEC = 'tool_saas_portal_codemode_execute';
const base: TraceEvent[] = [
  { type: 'run-start', runId: 'main', agent: 'main-chat', model: 'm', t: 0 },
  { type: 'span-start', id: 'main', kind: 'invoke_agent', name: 'main-chat', t: 0 },
  { type: 'span-start', id: 'main/c1', parentId: 'main', kind: 'execute_tool', name: 'ask_saas', t: 100 },
  { type: 'span-start', id: 'main/c1/tools', parentId: 'main/c1', kind: 'execute_tool', name: 'mcp.tools:saas#codemode', t: 120 },
];

describe('subagentSteps', () => {
  it('shows tool loading before the subagent starts', () => {
    const v = subagentSteps(trace(base), 'c1', 1120)!;
    expect(v.running).toBe(true);
    expect(v.steps).toEqual([{ kind: 'prepare', name: 'mcp.tools:saas#codemode', status: 'running', durationMs: 1000 }]);
  });

  it('returns null without the delegate span', () => {
    expect(subagentSteps(trace(base.slice(0, 2)), 'c1', 0)).toBeNull();
  });

  it('lists model calls and Code Mode runs in order, with the script being written live', () => {
    const v = subagentSteps(
      trace([
        ...base,
        { type: 'span-end', id: 'main/c1/tools', t: 1500, status: 'ok' },
        { type: 'span-start', id: AGENT, parentId: 'main/c1', kind: 'invoke_agent', name: 'saas-agent', t: 1500 },
        { type: 'span-start', id: `${AGENT}:chat:0`, parentId: AGENT, kind: 'chat', name: 'm', t: 1500 },
        { type: 'reasoning-delta', spanId: `${AGENT}:chat:0`, text: 'Plan: list orders' },
        { type: 'span-start', id: `${AGENT}/x1`, parentId: AGENT, kind: 'execute_tool', name: EXEC, t: 2000 },
        { type: 'tool-input-delta', spanId: `${AGENT}/x1`, text: '{"code":"async () => {\\n  const r' },
      ]),
      'c1',
      2500,
    )!;
    expect(v.steps.map((s) => s.kind)).toEqual(['prepare', 'model', 'tool']);
    expect(v.steps[1]).toMatchObject({ kind: 'model', index: 1, status: 'running', reasoning: 'Plan: list orders' });
    expect(v.steps[2]).toMatchObject({ kind: 'tool', name: EXEC, status: 'writing', code: 'async () => {\n  const r', durationMs: 500 });
  });

  it('reads the finished script, its result, inner steps and tokens', () => {
    const result = JSON.stringify({
      steps: [
        { tool: 'sap_list_sales_orders', args: {}, n: 12, ms: 340 },
        { tool: 'sap_get_sales_order', args: { id: '1' }, n: 3, ms: 120 },
        { tool: 'sap_get_product', args: { id: 'P1' }, error: 'not found', ms: 80 },
      ],
      result: { top: ['P1'] },
    });
    const v = subagentSteps(
      trace([
        ...base,
        { type: 'span-end', id: 'main/c1/tools', t: 1500, status: 'ok' },
        { type: 'span-start', id: AGENT, parentId: 'main/c1', kind: 'invoke_agent', name: 'saas-agent', t: 1500 },
        { type: 'span-start', id: `${AGENT}:chat:0`, parentId: AGENT, kind: 'chat', name: 'm', t: 1500 },
        { type: 'span-start', id: `${AGENT}/x1`, parentId: AGENT, kind: 'execute_tool', name: EXEC, t: 2000 },
        { type: 'span-input', id: `${AGENT}/x1`, input: { code: 'async () => 1' } },
        { type: 'span-end', id: `${AGENT}:chat:0`, t: 2100, status: 'ok', usage: { input: 5000, output: 300 }, ttftMs: 400 },
        { type: 'span-end', id: `${AGENT}/x1`, t: 4100, status: 'ok', detail: { input: { code: 'async () => 1' }, output: { source: 'SAP', result } } },
        { type: 'span-start', id: `${AGENT}:chat:1`, parentId: AGENT, kind: 'chat', name: 'm', t: 4100 },
        { type: 'text-delta', spanId: `${AGENT}:chat:1`, text: 'Top product: P1' },
        { type: 'span-end', id: `${AGENT}:chat:1`, t: 5000, status: 'ok', usage: { input: 6000, output: 100 } },
        { type: 'span-end', id: AGENT, t: 5000, status: 'ok' },
        { type: 'span-end', id: 'main/c1', t: 5000, status: 'ok' },
      ]),
      'c1',
      9000,
    )!;
    expect(v).toMatchObject({ running: false, durationMs: 4900, modelCalls: 2, inputTokens: 11000, outputTokens: 400 });
    const exec = v.steps.find((s) => s.kind === 'tool')!;
    expect(exec).toMatchObject({ status: 'done', code: 'async () => 1', durationMs: 2100 });
    if (exec.kind !== 'tool') throw new Error('tool');
    expect(exec.innerSteps).toEqual([
      { tool: 'sap_list_sales_orders', args: {}, n: 12, ms: 340 },
      { tool: 'sap_get_sales_order', args: { id: '1' }, n: 3, ms: 120 },
      { tool: 'sap_get_product', args: { id: 'P1' }, error: 'not found', ms: 80 },
    ]);
    expect(exec.result).toEqual({ top: ['P1'] });
    expect(v.steps[v.steps.length - 1]).toMatchObject({ kind: 'model', index: 2, text: 'Top product: P1', status: 'done' });
  });

  it('marks held-back writes, Gateway blocks and errors', () => {
    const steps = (output: unknown, status: 'ok' | 'error' = 'ok', detail?: unknown) =>
      subagentSteps(
        trace([
          ...base,
          { type: 'span-start', id: AGENT, parentId: 'main/c1', kind: 'invoke_agent', name: 'saas-agent', t: 1500 },
          { type: 'span-start', id: `${AGENT}/x1`, parentId: AGENT, kind: 'execute_tool', name: EXEC, t: 2000 },
          { type: 'span-end', id: `${AGENT}/x1`, t: 2500, status, detail: detail ?? { input: {}, output } },
        ]),
        'c1',
        3000,
      )!.steps.find((s) => s.kind === 'tool');
    expect(steps({ pendingApproval: true, approvalId: 'apr_1', risk: 'high' })).toMatchObject({ status: 'approval', approvalId: 'apr_1' });
    expect(steps({ blocked: true, ruleId: 'r1' })).toMatchObject({ status: 'blocked' });
    expect(steps(undefined, 'error', { error: 'boom' })).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('shows the latest attempt after a retry', () => {
    const v = subagentSteps(
      trace([
        ...base,
        { type: 'span-start', id: AGENT, parentId: 'main/c1', kind: 'invoke_agent', name: 'saas-agent', t: 1500 },
        { type: 'span-end', id: AGENT, t: 1600, status: 'error', detail: { error: 'idle' } },
        { type: 'span-start', id: `${AGENT}r`, parentId: 'main/c1', kind: 'invoke_agent', name: 'saas-agent', t: 1700 },
      ]),
      'c1',
      2000,
    )!;
    expect(v.retried).toBe(true);
    expect(v.durationMs).toBe(1900);
  });
});

describe('partialJsonString', () => {
  it('decodes a string value that is still being written', () => {
    expect(partialJsonString('{"code":"a\\nb\\"c', 'code')).toBe('a\nb"c');
    expect(partialJsonString('{"code":"done"}', 'code')).toBe('done');
  });
  it('drops a cut-off escape at the end', () => {
    expect(partialJsonString('{"code":"ab\\', 'code')).toBe('ab');
    expect(partialJsonString('{"code":"ab\\u00', 'code')).toBe('ab');
  });
  it('returns null when the key has not started', () => {
    expect(partialJsonString('{"co', 'code')).toBeNull();
  });
});

describe('parseCodeResult', () => {
  it('keeps the raw text when the result is not JSON', () => {
    expect(parseCodeResult({ result: 'plain text' })).toEqual({ resultText: 'plain text' });
  });
  it('accepts name / count / duration spellings and ignores junk entries', () => {
    const r = parseCodeResult({ result: JSON.stringify({ steps: [{ name: 'a', count: 2, duration: 5 }, 'junk'], result: 1 }) });
    expect(r.innerSteps).toEqual([{ tool: 'a', n: 2, ms: 5 }]);
    expect(r.result).toBe(1);
  });
  it('reads a result that is already an object', () => {
    expect(parseCodeResult({ steps: [{ tool: 'a' }], result: 2 })).toEqual({ innerSteps: [{ tool: 'a' }], result: 2 });
  });
});
