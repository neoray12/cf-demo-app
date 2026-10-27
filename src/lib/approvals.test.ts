import { describe, it, expect } from 'vitest';
import { baseToolName, classifyCall, canTransition, isTerminal, appendEvent, decisionRight, HITL_EXAMPLES } from './approvals';
import zhTW from '../i18n/zh-TW.json';
import en from '../i18n/en.json';

describe('baseToolName', () => {
  it('strips the delegate key, portal server and Code Mode prefixes', () => {
    expect(baseToolName('tool_saas_salesforce-mcp_sf_update_opportunity', 'saas')).toBe('sf_update_opportunity');
    expect(baseToolName('salesforce_mcp_sf_create_lead')).toBe('sf_create_lead');
    expect(baseToolName('sap-mcp_sap_close_production_order')).toBe('sap_close_production_order');
    expect(baseToolName('sf_list_accounts')).toBe('sf_list_accounts');
  });
});

describe('classifyCall', () => {
  it('lets reads through', () => {
    expect(classifyCall('salesforce-mcp_sf_list_accounts', { top: 5 })).toBeNull();
    expect(classifyCall('sap-mcp_sap_get_sales_order', { id: '1' })).toBeNull();
  });

  it('treats ordinary Salesforce writes as low risk', () => {
    expect(classifyCall('salesforce-mcp_sf_create_lead', { last_name: 'Wang' })).toMatchObject({ risk: 'low', writes: ['sf_create_lead'] });
    expect(classifyCall('salesforce-mcp_sf_update_opportunity', { opportunity_id: '006', stage: 'Negotiation/Review' })?.risk).toBe('low');
  });

  it('treats closing a deal, big amounts and SAP order changes as high risk', () => {
    expect(classifyCall('salesforce-mcp_sf_update_opportunity', { opportunity_id: '006', stage: 'Closed Won' })?.risk).toBe('high');
    expect(classifyCall('salesforce-mcp_sf_create_opportunity', { name: 'Big', amount: 1_500_000 })?.risk).toBe('high');
    expect(classifyCall('sap-mcp_sap_create_sales_order', { customer: '17100001' })?.risk).toBe('high');
    expect(classifyCall('sap-mcp_sap_release_production_order', { order: '1000007' })?.risk).toBe('high');
  });

  it('holds a whole Code Mode script that calls a write tool', () => {
    const code = `async () => {
      const r = await codemode.salesforce_mcp_sf_list_opportunities({ top: 5 });
      await codemode.salesforce_mcp_sf_update_opportunity({ opportunity_id: r.records[0].Id, stage: 'Closed Won' });
      return 'ok';
    }`;
    expect(classifyCall('portal_codemode_execute', { code })).toMatchObject({ risk: 'high', writes: ['sf_update_opportunity'] });
    expect(classifyCall('portal_codemode_execute', { code: 'async () => codemode.salesforce_mcp_sf_create_lead({ last_name: "A" })' })?.risk).toBe('low');
  });

  it('spots a big amount written in a Code Mode script', () => {
    const big = 'async () => codemode.salesforce_mcp_sf_create_opportunity({ name: "年度合約", amount: 1_500_000, stage: "Prospecting" })';
    expect(classifyCall('portal_codemode_execute', { code: big })?.risk).toBe('high');
    const small = 'async () => codemode.salesforce_mcp_sf_create_opportunity({ name: "小案", amount: 50000, stage: "Prospecting" })';
    expect(classifyCall('portal_codemode_execute', { code: small })?.risk).toBe('low');
  });

  it('lets read-only Code Mode scripts through', () => {
    expect(classifyCall('portal_codemode_execute', { code: 'async () => codemode.salesforce_mcp_sf_list_accounts({})' })).toBeNull();
    expect(classifyCall('portal_codemode_search', { code: 'async () => codemode.tools()' })).toBeNull();
  });
});

describe('status transitions', () => {
  it('only allows forward moves from pending', () => {
    expect(canTransition('pending', 'approved')).toBe(true);
    expect(canTransition('pending', 'rejected')).toBe(true);
    expect(canTransition('pending', 'expired')).toBe(true);
    expect(canTransition('approved', 'executing')).toBe(true);
    expect(canTransition('executing', 'done')).toBe(true);
    expect(canTransition('executing', 'failed')).toBe(true);
    expect(canTransition('rejected', 'approved')).toBe(false);
    expect(canTransition('done', 'executing')).toBe(false);
    expect(canTransition('pending', 'done')).toBe(false);
  });

  it('knows the terminal states', () => {
    expect(['rejected', 'done', 'failed', 'expired'].every((s) => isTerminal(s as never))).toBe(true);
    expect(isTerminal('pending')).toBe(false);
  });
});

describe('appendEvent', () => {
  it('adds a timeline entry to the stored JSON', () => {
    const one = appendEvent(null, { at: 1, step: 'created', label: '已建立審批' });
    const two = appendEvent(one, { at: 2, step: 'email', label: '已寄信給主管' });
    expect(JSON.parse(two)).toEqual([
      { at: 1, step: 'created', label: '已建立審批' },
      { at: 2, step: 'email', label: '已寄信給主管' },
    ]);
  });
});

describe('decisionRight', () => {
  const base = { status: 'pending' as const };
  it('lets the requester decide a low-risk approval in the chat', () => {
    expect(decisionRight({ ...base, risk: 'low' }, { requester: true, linkHolder: false })).toBe(true);
    expect(decisionRight({ ...base, risk: 'low' }, { requester: false, linkHolder: true })).toBe(false);
  });
  it('needs the email link for a high-risk approval, even for the requester', () => {
    expect(decisionRight({ ...base, risk: 'high' }, { requester: true, linkHolder: false })).toBe(false);
    expect(decisionRight({ ...base, risk: 'high' }, { requester: false, linkHolder: true })).toBe(true);
  });
  it('allows no decision once it left pending', () => {
    expect(decisionRight({ status: 'approved', risk: 'low' }, { requester: true, linkHolder: true })).toBe(false);
  });
});

describe('HITL_EXAMPLES', () => {
  it('has both risk levels and a title and prompt in both languages', () => {
    expect(HITL_EXAMPLES.filter((e) => e.risk === 'low').length).toBeGreaterThanOrEqual(2);
    expect(HITL_EXAMPLES.filter((e) => e.risk === 'high').length).toBeGreaterThanOrEqual(2);
    for (const lang of [zhTW, en]) {
      const items = (lang as unknown as { chat: { hitlSuggestions: Record<string, { title?: string; prompt?: string }> } }).chat.hitlSuggestions;
      for (const { key } of HITL_EXAMPLES) {
        expect(items[key]?.title, key).toBeTruthy();
        expect(items[key]?.prompt, key).toBeTruthy();
      }
    }
  });
});
