import { describe, it, expect } from 'vitest';
import { resolveToolPolicy, delegateToolName, MCP_DIRECT_MAX, type ToolPolicyInput } from './tool-policy';
import { parseMcpServerUrls } from './mcp-client';

const [cfDocs, radar, saas] = parseMcpServerUrls(
  'cf-docs=https://docs.mcp.cloudflare.com/mcp,cf-radar=https://radar.mcp.cloudflare.com/mcp:oauth,saas=https://saasmcp.neokung.work/mcp:oauth:agent:codemode',
);

const base: ToolPolicyInput = {
  modelSupportsTools: true,
  bindings: { sandbox: true, loader: true, browser: true },
  hasImages: false,
  servers: [],
};

describe('resolveToolPolicy', () => {
  it('gives a model without tool calling no tools at all, even with MCP connected', () => {
    expect(resolveToolPolicy({ ...base, modelSupportsTools: false, servers: [{ config: saas!, toolCount: 3 }] })).toEqual({
      core: [],
      directServers: [],
      delegated: [],
    });
  });

  it('always loads the core tools the bindings allow', () => {
    expect(resolveToolPolicy(base).core).toEqual([
      'searchKnowledge',
      'readWebPage',
      'captureScreenshot',
      'executeJs',
      'executeCode',
      'createWebPreview',
    ]);
    expect(resolveToolPolicy({ ...base, hasImages: true }).core).toContain('searchKnowledgeByImage');
    expect(resolveToolPolicy({ ...base, bindings: { sandbox: false, loader: false, browser: true } }).core).toEqual([
      'searchKnowledge',
      'readWebPage',
      'captureScreenshot',
    ]);
  });

  it('gives a small MCP server straight to the main model', () => {
    const p = resolveToolPolicy({ ...base, servers: [{ config: cfDocs!, toolCount: 2 }] });
    expect(p.directServers).toEqual(['cf-docs']);
    expect(p.delegated).toEqual([]);
  });

  it('delegates a server with more than MCP_DIRECT_MAX tools', () => {
    expect(MCP_DIRECT_MAX).toBe(8);
    const p = resolveToolPolicy({ ...base, servers: [{ config: radar!, toolCount: 9 }] });
    expect(p.directServers).toEqual([]);
    expect(p.delegated).toEqual([{ serverId: 'cf-radar', toolName: 'ask_cf-radar', codeMode: false }]);
  });

  it('delegates an :agent server regardless of size and keeps its :codemode choice', () => {
    const p = resolveToolPolicy({ ...base, servers: [{ config: saas!, toolCount: 3 }] });
    expect(p.delegated).toEqual([{ serverId: 'saas', toolName: 'ask_saas', codeMode: true }]);
  });

  it('lets an experiment override Code Mode', () => {
    const p = resolveToolPolicy({ ...base, servers: [{ config: saas!, toolCount: 3 }], experiment: { id: 'sf-agg', codeMode: false } });
    expect(p.delegated[0]!.codeMode).toBe(false);
  });
});

describe('delegateToolName', () => {
  it('sanitizes the server id', () => {
    expect(delegateToolName('cf.radar')).toBe('ask_cf_radar');
    expect(delegateToolName('saas')).toBe('ask_saas');
  });
});
