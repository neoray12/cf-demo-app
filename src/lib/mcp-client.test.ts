import { describe, it, expect } from 'vitest';
import { parseMcpServerUrls, portalCodeModeUrl } from './mcp-client';

describe('parseMcpServerUrls flags', () => {
  it('reads oauth, agent and codemode flags', () => {
    const [s] = parseMcpServerUrls('saas=https://saasmcp.neokung.work/mcp:oauth:agent:codemode');
    expect(s).toMatchObject({
      id: 'saas',
      url: 'https://saasmcp.neokung.work/mcp',
      authType: 'oauth',
      delegate: true,
      codeMode: true,
    });
  });

  it('defaults every flag off for a plain public server', () => {
    const [s] = parseMcpServerUrls('cf-docs=https://docs.mcp.cloudflare.com/mcp');
    expect(s).toMatchObject({ url: 'https://docs.mcp.cloudflare.com/mcp', authType: 'none', delegate: false, codeMode: false });
  });

  it('accepts the flags in any order', () => {
    const [a] = parseMcpServerUrls('x=https://a/mcp:codemode:oauth');
    expect(a).toMatchObject({ url: 'https://a/mcp', authType: 'oauth', delegate: false, codeMode: true });
  });
});

describe('portalCodeModeUrl', () => {
  it('adds the search_and_execute query', () => {
    expect(portalCodeModeUrl('https://a/mcp')).toBe('https://a/mcp?codemode=search_and_execute');
    expect(portalCodeModeUrl('https://a/mcp?x=1')).toBe('https://a/mcp?x=1&codemode=search_and_execute');
  });
});
