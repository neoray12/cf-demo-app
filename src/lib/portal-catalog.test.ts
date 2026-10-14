import { describe, expect, it } from 'vitest';
import { formatPortalCatalog, isPortalCodeModeUrl, parsePortalCatalog } from './portal-catalog';

describe('isPortalCodeModeUrl', () => {
  it('detects the codemode query parameter', () => {
    expect(isPortalCodeModeUrl('https://saasmcp.neokung.work/mcp?codemode=search_and_execute')).toBe(true);
    expect(isPortalCodeModeUrl('https://saasmcp.neokung.work/mcp')).toBe(false);
    expect(isPortalCodeModeUrl('https://saasmcp.neokung.work/mcp?codemode=off')).toBe(false);
  });
});

describe('parsePortalCatalog', () => {
  it('reads name/description rows from the search result text', () => {
    const text = JSON.stringify([{ name: 'salesforce_mcp_sf_list_accounts', description: '搜尋並列出公司/組織帳戶\n第二行' }, { name: 'x' }]);
    expect(parsePortalCatalog(text)).toEqual([
      { name: 'salesforce_mcp_sf_list_accounts', description: '搜尋並列出公司/組織帳戶' },
      { name: 'x', description: '' },
    ]);
  });
  it('returns [] for anything else', () => {
    expect(parsePortalCatalog('Error: boom')).toEqual([]);
    expect(parsePortalCatalog('{"a":1}')).toEqual([]);
  });
});

describe('formatPortalCatalog', () => {
  it('lists callable names for the system prompt', () => {
    const out = formatPortalCatalog('SAP & Salesforce (Code Mode)', [
      { name: 'salesforce_mcp_sf_list_accounts', description: '列出帳戶' },
      { name: 'sap_mcp_sap_list_customers', description: '' },
    ]);
    expect(out).toContain('SAP & Salesforce (Code Mode)');
    expect(out).toContain('- codemode.salesforce_mcp_sf_list_accounts(args) — 列出帳戶');
    expect(out).toContain('- codemode.sap_mcp_sap_list_customers(args)\n');
    expect(out).toContain('portal_codemode_execute');
  });
  it('is empty when there are no tools', () => {
    expect(formatPortalCatalog('x', [])).toBe('');
  });
});
