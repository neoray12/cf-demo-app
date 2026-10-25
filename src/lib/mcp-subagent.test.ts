import { describe, it, expect } from 'vitest';
import { subagentDef, buildDelegateTool } from './mcp-subagent';
import { parseMcpServerUrls } from './mcp-client';
import type { RunContext, SubagentDef } from './agents/runtime';

const [saas] = parseMcpServerUrls('saas=https://saasmcp.neokung.work/mcp:oauth:agent:codemode');
const ctx = { signal: new AbortController().signal } as unknown as RunContext;

describe('subagentDef', () => {
  it('names the subagent after the server and caps its steps', () => {
    const def = subagentDef(saas!, {}, '', false);
    expect(def.functionId).toBe('saas-agent');
    expect(def.maxSteps).toBe(8);
    expect(def.prompt({ task: 'list accounts' })).toContain('list accounts');
  });

  it('adds the Portal tool catalog only in Code Mode', () => {
    expect(subagentDef(saas!, {}, 'CATALOG', true).system).toContain('CATALOG');
    expect(subagentDef(saas!, {}, 'CATALOG', false).system).not.toContain('CATALOG');
  });
});

describe('buildDelegateTool', () => {
  const blockedTool = { description: 'x', execute: async () => ({ blocked: true, ruleId: 'rule-1', direction: 'request' }) };

  it('describes the server and its operations', () => {
    const tool = buildDelegateTool({
      server: saas!, toolNames: ['sf_list_accounts', 'sap_list_customers'], ctx, parentSpanId: 'main', codeMode: false,
      loadTools: async () => ({ tools: {}, catalogPrompt: '' }),
    });
    expect(tool.description).toContain('SAP & Salesforce');
    expect(tool.description).toContain('sf_list_accounts, sap_list_customers');
  });

  it('reports a Gateway block from inside the subagent', async () => {
    const run = async (def: SubagentDef<{ task: string }>) => {
      const tools = def.tools(ctx) as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>;
      await tools.close!.execute({}, { toolCallId: 'c' });
      return { text: 'The close action was blocked.' };
    };
    const tool = buildDelegateTool({
      server: saas!, toolNames: ['close'], ctx, parentSpanId: 'main', codeMode: false, run,
      loadTools: async () => ({ tools: { close: blockedTool }, catalogPrompt: '' }),
    });
    const out = await tool.execute!({ task: 'close the deal' }, { toolCallId: 't1', messages: [] });
    expect(out).toMatchObject({ result: 'The close action was blocked.', blocked: true, ruleId: 'rule-1', codeMode: false });
  });

  it('returns the error instead of throwing when the subagent fails', async () => {
    const tool = buildDelegateTool({
      server: saas!, toolNames: [], ctx, parentSpanId: 'main', codeMode: true,
      run: async () => { throw new Error('model overloaded'); },
      loadTools: async () => ({ tools: {}, catalogPrompt: '' }),
    });
    expect(await tool.execute!({ task: 'x' }, { toolCallId: 't2', messages: [] })).toEqual({ error: 'model overloaded' });
  });

  it('runs the subagent under the delegate tool span', async () => {
    const parents: string[] = [];
    const tool = buildDelegateTool({
      server: saas!, toolNames: [], ctx, parentSpanId: 'main', codeMode: false,
      run: async (_def, _input, _ctx, parentSpanId) => { parents.push(parentSpanId); return { text: 'ok' }; },
      loadTools: async () => ({ tools: {}, catalogPrompt: '' }),
    });
    expect(await tool.execute!({ task: 'x' }, { toolCallId: 'c9', messages: [] })).toEqual({ result: 'ok', codeMode: false });
    expect(parents).toEqual(['main/c9']);
  });
});
