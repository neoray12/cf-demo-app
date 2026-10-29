import { describe, expect, it } from 'vitest';
import { PORTAL_CATALOG_SEARCH_CODE, formatPortalCatalog, isPortalCodeModeUrl, parsePortalCatalog } from './portal-catalog';

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
  it('keeps the argument names (optional ones marked with ?)', () => {
    const text = JSON.stringify([{ name: 'sf_list_opportunities', description: '列出商機', params: ['accountId?', 'limit?'] }]);
    expect(parsePortalCatalog(text)).toEqual([{ name: 'sf_list_opportunities', description: '列出商機', params: ['accountId?', 'limit?'] }]);
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
  it('shows the argument names so the model can call without searching first', () => {
    const out = formatPortalCatalog('SAP & Salesforce', [
      { name: 'sf_get_account', description: '取得帳戶', params: ['accountId'] },
      { name: 'sf_list_accounts', description: '', params: [] },
    ]);
    expect(out).toContain('- codemode.sf_get_account({ accountId }) — 取得帳戶');
    expect(out).toContain('- codemode.sf_list_accounts({})\n');
  });
  it('asks for one script that computes and returns only the result', () => {
    const out = formatPortalCatalog('x', [{ name: 'a', description: '' }]);
    expect(out).toContain('Promise.all');
    expect(out).toContain('不要 return 原始 records');
  });
  it('explains the text-array result shape (SAP) so the first script parses it', () => {
    const out = formatPortalCatalog('x', [{ name: 'a', description: '' }]);
    expect(out).toContain("[{ type: 'text', text }]");
    expect(out).toContain("r.map((x) => x.text).join('\\n')");
  });
  it('asks the script to log each call and return { steps, result }', () => {
    const out = formatPortalCatalog('x', [{ name: 'a', description: '' }]);
    expect(out).toContain('const steps = [];');
    expect(out).toContain("await call('");
    expect(out).toContain('return { steps, result');
  });
  it('is empty when there are no tools', () => {
    expect(formatPortalCatalog('x', [])).toBe('');
  });
});

describe('PORTAL_CATALOG_SEARCH_CODE', () => {
  it('returns name, first description line and argument names from codemode.tools()', async () => {
    const codemode = {
      tools: async () => [
        { name: 'sf_get_account', description: '取得帳戶\n細節', inputSchema: { type: 'object', properties: { accountId: {}, fields: {} }, required: ['accountId'] } },
        { name: 'sap_list_customers', inputSchema: { type: 'object' } },
      ],
    };
    const fn = new Function('codemode', `return (${PORTAL_CATALOG_SEARCH_CODE})();`);
    expect(await fn(codemode)).toEqual([
      { name: 'sf_get_account', description: '取得帳戶', params: ['accountId', 'fields?'] },
      { name: 'sap_list_customers', description: '', params: [] },
    ]);
  });
});
