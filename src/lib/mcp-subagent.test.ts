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

describe('buildDelegateTool abort', () => {
  it("stops the subagent when the main stream is aborted (tool abortSignal)", async () => {
    const signals: AbortSignal[] = [];
    const tool = buildDelegateTool({
      server: saas!, toolNames: [], ctx, parentSpanId: 'main', codeMode: false,
      run: async (_def, _input, subCtx) => { signals.push(subCtx.signal); return { text: 'ok' }; },
      loadTools: async () => ({ tools: {}, catalogPrompt: '' }),
    });
    const stream = new AbortController();
    stream.abort(new Error('idle'));
    await tool.execute!({ task: 'x' }, { toolCallId: 'c1', messages: [], abortSignal: stream.signal });
    expect(signals[0]!.aborted).toBe(true);
    expect(ctx.signal.aborted).toBe(false);
  });
});

describe('buildDelegateTool approvals', () => {
  it('turns a write into an approval request instead of calling it, and lets reads through', async () => {
    const called: string[] = [];
    const requested: Array<{ toolName: string; args: unknown }> = [];
    const mk = (name: string) => ({ description: name, execute: async () => { called.push(name); return { ok: name }; } });
    const run = async (def: SubagentDef<{ task: string }>) => {
      const tools = def.tools(ctx) as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>;
      await tools['tool_saas_salesforce-mcp_sf_list_opportunities']!.execute({ top: 3 }, { toolCallId: 'r' });
      const pending = await tools['tool_saas_salesforce-mcp_sf_update_opportunity']!.execute({ opportunity_id: '006', stage: 'Closed Won' }, { toolCallId: 'w' });
      expect(pending).toMatchObject({ pendingApproval: true, approvalId: 'apr_1', risk: 'high' });
      return { text: '已送出審批' };
    };
    const tool = buildDelegateTool({
      server: saas!, toolNames: [], ctx, parentSpanId: 'main', codeMode: false, run,
      loadTools: async () => ({
        tools: {
          'tool_saas_salesforce-mcp_sf_list_opportunities': mk('list'),
          'tool_saas_salesforce-mcp_sf_update_opportunity': mk('update'),
        },
        catalogPrompt: '',
      }),
      requestApproval: async (call) => {
        requested.push({ toolName: call.toolName, args: call.args });
        return { id: 'apr_1', risk: call.classification.risk, summary: 'close', status: 'pending' };
      },
    });
    const out = await tool.execute!({ task: 'close it' }, { toolCallId: 't', messages: [] });
    expect(called).toEqual(['list']);
    expect(requested).toEqual([{ toolName: 'salesforce-mcp_sf_update_opportunity', args: { opportunity_id: '006', stage: 'Closed Won' } }]);
    expect(out).toMatchObject({ result: '已送出審批', approvals: [{ id: 'apr_1', risk: 'high', status: 'pending' }] });
  });

  it('holds a Code Mode script that writes', async () => {
    const run = async (def: SubagentDef<{ task: string }>) => {
      const tools = def.tools(ctx) as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>;
      await tools.tool_saas_portal_codemode_execute!.execute({ code: 'async () => codemode.salesforce_mcp_sf_create_lead({ last_name: "A" })' }, { toolCallId: 'x' });
      return { text: 'ok' };
    };
    const seen: string[] = [];
    const tool = buildDelegateTool({
      server: saas!, toolNames: [], ctx, parentSpanId: 'main', codeMode: true, run,
      loadTools: async () => ({ tools: { tool_saas_portal_codemode_execute: { description: 'x', execute: async () => 'ran' } }, catalogPrompt: '' }),
      requestApproval: async (call) => { seen.push(call.toolName); return { id: 'apr_2', risk: call.classification.risk, summary: 's', status: 'pending' }; },
    });
    const out = await tool.execute!({ task: 'x' }, { toolCallId: 't', messages: [] });
    expect(seen).toEqual(['portal_codemode_execute']);
    expect(out).toMatchObject({ approvals: [{ id: 'apr_2', risk: 'low' }] });
  });
});
