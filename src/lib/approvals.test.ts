import { describe, it, expect } from 'vitest';
import { baseToolName, classifyCall, canTransition, isTerminal, appendEvent, decisionRight, HITL_EXAMPLES, decisionLabel, recordDecision } from './approvals';
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

describe('chat.approval.waitingManager', () => {
  it('tells the requester the manager can also reply to the email, in both languages', () => {
    const zh = (zhTW as unknown as { chat: { approval: { waitingManager: string } } }).chat.approval.waitingManager;
    const enText = (en as unknown as { chat: { approval: { waitingManager: string } } }).chat.approval.waitingManager;
    expect(zh).toContain('回信');
    expect(zh).toMatch(/核准.*拒絕/);
    expect(enText.toLowerCase()).toContain('reply');
  });
});

describe('decisionLabel', () => {
  it('names who decided and how', () => {
    expect(decisionLabel(true, '主管（Email 回信：neo@cloudflare.com）')).toBe('主管（Email 回信：neo@cloudflare.com） 已核准');
    expect(decisionLabel(false, 'neo@cloudflare.com')).toBe('neo@cloudflare.com 已拒絕');
  });
});

/** Just enough D1 for transition(): one row whose status the UPDATE's WHERE checks. */
function fakeDb(status: string) {
  const row = { status, events_json: null as string | null, decided_by: null as string | null };
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async first() {
          return sql.startsWith('SELECT') ? { events_json: row.events_json } : null;
        },
        async run() {
          // UPDATE … SET status = ?, events_json = ?, …, decided_by = COALESCE(?, …) … WHERE id = ? AND status IN (…)
          const n = sql.match(/status IN \(([^)]*)\)/)![1]!.split(',').length;
          if (!args.slice(args.length - n).includes(row.status)) return { meta: { changes: 0 } };
          row.status = args[0] as string;
          row.events_json = args[1] as string;
          row.decided_by = (args[4] as string | null) ?? row.decided_by;
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, row };
}

describe('recordDecision', () => {
  it('moves a pending approval to approved, with who decided on the timeline', async () => {
    const { db, row } = fakeDb('pending');
    expect(await recordDecision(db, 'apr_1', true, '主管（Email 連結）')).toBe(true);
    expect(row.status).toBe('approved');
    expect(row.decided_by).toBe('主管（Email 連結）');
    expect(JSON.parse(row.events_json!)).toMatchObject([{ step: 'approved', label: '主管（Email 連結） 已核准' }]);
  });
  it('moves a pending approval to rejected', async () => {
    const { db, row } = fakeDb('pending');
    expect(await recordDecision(db, 'apr_1', false, 'x')).toBe(true);
    expect(row.status).toBe('rejected');
  });
  it('returns false when someone already decided', async () => {
    const { db, row } = fakeDb('approved');
    expect(await recordDecision(db, 'apr_1', false, 'x')).toBe(false);
    expect(row.status).toBe('approved');
  });
});
