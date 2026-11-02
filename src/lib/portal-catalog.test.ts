import { describe, expect, it } from 'vitest';
import { PORTAL_CATALOG_SEARCH_CODE, formatPortalCatalog, isPortalCodeModeUrl, parsePortalCatalog, prepareCodeModeArgs, withStepLog, codeModeModelOutput } from './portal-catalog';

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
    expect(out).toContain('- salesforce_mcp_sf_list_accounts(args) — 列出帳戶');
    expect(out).toContain('- sap_mcp_sap_list_customers(args)\n');
    expect(out).toContain('portal_codemode_execute');
  });
  it('shows the argument names so the model can call without searching first', () => {
    const out = formatPortalCatalog('SAP & Salesforce', [
      { name: 'sf_get_account', description: '取得帳戶', params: ['accountId'] },
      { name: 'sf_list_accounts', description: '', params: [] },
    ]);
    expect(out).toContain('- sf_get_account({ accountId }) — 取得帳戶');
    expect(out).toContain('- sf_list_accounts({})\n');
  });
  it('asks for one script that computes and returns only the result', () => {
    const out = formatPortalCatalog('x', [{ name: 'a', description: '' }]);
    expect(out).toContain('Promise.all');
    expect(out).toContain('不要 return 原始 records');
  });
  it('names the execute tool the model actually has', () => {
    expect(formatPortalCatalog('x', [{ name: 'a', description: '' }], 'tool_saas_portal_codemode_execute')).toContain('`tool_saas_portal_codemode_execute`');
  });
  it('documents the predefined helpers instead of asking the script to write them', () => {
    const out = formatPortalCatalog('x', [{ name: 'a', description: '' }]);
    for (const h of ['call(name, args)', 'rows(r)', 'fields(r)', 'all(name, args)', 'num(v)']) expect(out).toContain(h);
    expect(out).not.toContain('const steps = [];');
    expect(out).toContain('不要註解');
  });
  it('shows the SAP line formats so the first script can parse without a probing run', () => {
    const out = formatPortalCatalog('x', [{ name: 'a', description: '' }]);
    expect(out).toContain('- Item 10: Product=FG126, "Finished Good 126, MTS, PD, Serial", Qty=25 PC, Net=31250.00 USD');
    expect(out).toContain('- RM122: Required=20 PC');
    expect(out).toContain('- 17100001:');
  });
  it('lists the fields the Salesforce list tools return and points aggregates at SOQL', () => {
    const out = formatPortalCatalog('x', [{ name: 'a', description: '' }]);
    expect(out).toContain('不含 AccountId');
    expect(out).toContain('GROUP BY AccountId');
  });
  it('tells the model to stop once the script succeeded', () => {
    expect(formatPortalCatalog('x', [{ name: 'a', description: '' }])).toContain('不要再跑驗證');
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

// Runs a wrapped Code Mode script the way the Portal does: an async function
// expression evaluated with `codemode` in scope.
async function runScript(code: string, codemode: Record<string, (args: unknown) => Promise<unknown>>) {
  const fn = new Function('codemode', `return (${code})();`);
  return fn(codemode);
}

describe('withStepLog', () => {
  const codemode = {
    sap_list: async () => [{ type: 'text', text: 'Found 2 sales orders (showing 2):\n- 1: Type=OR\n- 2: Type=OR' }],
    sf_list: async () => ({ totalSize: 3, records: [{}, {}, {}] }),
    boom: async () => { throw new Error('nope'); },
  };

  it('defines call() and returns { steps, result } around an async arrow function', async () => {
    const code = "async () => { const r = await call('sap_list', {}); const s = await call('sf_list', { limit: 3 }); return { orders: 2, accounts: s.totalSize }; }";
    const out = await runScript(withStepLog(code), codemode);
    expect(out.result).toEqual({ orders: 2, accounts: 3 });
    expect(out.steps.map((s: { tool: string; n?: number }) => [s.tool, s.n])).toEqual([['sap_list', 2], ['sf_list', 3]]);
    expect(out.steps[1].args).toEqual({ limit: 3 });
  });

  it('accepts a trailing semicolon, a parenthesised function and bare statements', async () => {
    for (const code of [
      "async () => { return (await call('sf_list')).totalSize; };",
      "(async () => { return (await call('sf_list')).totalSize; })",
      "const s = await call('sf_list');\nreturn s.totalSize;",
    ]) {
      const out = await runScript(withStepLog(code), codemode);
      expect(out.result).toBe(3);
      expect(out.steps).toHaveLength(1);
    }
  });

  it('keeps the steps when the script throws', async () => {
    const out = await runScript(withStepLog("async () => { await call('sf_list'); await call('boom'); }"), codemode);
    expect(out.error).toBe('nope');
    expect(out.steps.map((s: { tool: string; error?: string }) => [s.tool, s.error])).toEqual([['sf_list', undefined], ['boom', 'nope']]);
  });

  it('leaves a script that defines its own call() alone', () => {
    const code = 'async () => { const steps = []; const call = async (t, a) => codemode[t](a); return { steps, result: 1 }; }';
    expect(withStepLog(code)).toBe(code);
  });
});

describe('prepareCodeModeArgs', () => {
  it('wraps the code of portal_codemode_execute only', () => {
    const args = { code: "async () => (await call('sf_list')).totalSize" };
    expect(prepareCodeModeArgs('portal_codemode_execute', args).code).toBe(withStepLog(args.code));
    expect(prepareCodeModeArgs('portal_codemode_search', args)).toBe(args);
    expect(prepareCodeModeArgs('sf_list_accounts', args)).toBe(args);
    expect(prepareCodeModeArgs('portal_codemode_execute', {})).toEqual({});
  });
});

describe('codeModeModelOutput', () => {
  const portal = (v: unknown) => ({ source: 'SAP & Salesforce', result: JSON.stringify(v, null, 2) });

  it('gives the model only the result, as compact JSON (the steps are for the UI)', () => {
    const out = codeModeModelOutput(portal({ steps: [{ tool: 'sf_list', args: {}, n: 3, ms: 900 }], result: { top: [{ name: 'A', amount: 10 }] } }));
    expect(out).toEqual({ type: 'text', value: '{"top":[{"name":"A","amount":10}]}' });
  });

  it('keeps the error and the failed call when the script threw', () => {
    const out = codeModeModelOutput(portal({ steps: [{ tool: 'a', args: {}, ms: 1 }, { tool: 'b', args: { id: 1 }, error: 'nope', ms: 2 }], error: 'nope' }));
    expect(out).toEqual({ type: 'text', value: '{"error":"nope","failedCalls":[{"tool":"b","args":{"id":1},"error":"nope"}],"completedCalls":1}' });
  });

  it('passes anything else through unchanged', () => {
    expect(codeModeModelOutput({ pendingApproval: true, approvalId: 'x' })).toEqual({ type: 'json', value: { pendingApproval: true, approvalId: 'x' } });
    expect(codeModeModelOutput({ source: 's', result: 'plain text' })).toEqual({ type: 'json', value: { source: 's', result: 'plain text' } });
    expect(codeModeModelOutput(portal({ a: 1 }))).toEqual({ type: 'text', value: '{"a":1}' });
  });
});

describe('script helpers (withStepLog)', () => {
  const sap = (t: string) => [{ type: 'text', text: t }];
  const run = (body: string, codemode: Record<string, (args: any) => Promise<unknown>>) => runScript(withStepLog(`async () => { ${body} }`), codemode);

  it('rows() turns SAP list lines into objects and passes Salesforce records through', async () => {
    const codemode = {
      items: async () => sap('Items for SO 6 (2):\n- Item 10: Product=FG126, "Finished Good 126, MTS, PD, Serial", Qty=25 PC, Net=31250.00 USD\n- Item 20: Product=TG11, "Trading Good 11", Qty=3 PC, Net=90.00 USD'),
      customers: async () => sap('Found 2 customers (showing 2):\n- 17100001: Domestic Customer 1 (Group: KUNA)\n- 17100002: ACME Co., Ltd. (Group: CUST)'),
      bp: async () => sap('Business Partner: 17100001\nFull Name: Domestic Customer 1\n\nAddresses (1):\n  - 22: Main St 1, Palo Alto, 94304, US'),
      accounts: async () => ({ totalSize: 1, records: [{ Id: 'a1', Name: 'GenePoint' }] }),
    };
    const out = await run(`
      const it = rows(await call('items'));
      const cu = rows(await call('customers'));
      const bp = await call('bp');
      return { it, cu, addr: rows(bp), f: fields(bp), sf: rows(await call('accounts')), n: num(it[0].Net) };`, codemode);
    expect(out.result.it[0]).toEqual({ id: '10', Product: 'FG126', text: 'Finished Good 126, MTS, PD, Serial', Qty: '25 PC', Net: '31250.00 USD' });
    expect(out.result.it).toHaveLength(2);
    expect(out.result.cu[1]).toMatchObject({ id: '17100002', name: 'ACME Co., Ltd.', Group: 'CUST' });
    expect(out.result.addr[0].parts.at(-1)).toBe('US');
    expect(out.result.f['Full Name']).toBe('Domestic Customer 1');
    expect(out.result.sf).toEqual([{ Id: 'a1', Name: 'GenePoint' }]);
    expect(out.result.n).toBe(31250);
    expect(out.steps.map((s: { n?: number }) => s.n)).toEqual([2, 2, 1, 1]);
  });

  it('fields() reads indented Key: Value lines (SAP plant data)', async () => {
    const plant = async () => sap('Plant data for FG226 (1 plants):\n\nPlant: 1710\n  Product: FG226\n  MRP Type: PD\n  Purchasing Group: N/A');
    const out = await run(`return fields(await call('plant'));`, { plant });
    expect(out.result).toMatchObject({ Plant: '1710', Product: 'FG226', 'MRP Type': 'PD', 'Purchasing Group': 'N/A' });
  });

  it('all() pages with top/skip until the list is complete', async () => {
    const seen: unknown[] = [];
    const list = async (args: { top: number; skip: number }) => {
      seen.push(args);
      const n = Math.max(0, Math.min(args.top, 250 - args.skip));
      return { totalSize: 250, records: Array.from({ length: n }, (_, i) => ({ i: args.skip + i })) };
    };
    const out = await run(`return (await all('list', { status: 'A' })).length;`, { list });
    expect(out.result).toBe(250);
    expect(seen).toEqual([{ status: 'A', top: 100, skip: 0 }, { status: 'A', top: 100, skip: 100 }, { status: 'A', top: 100, skip: 200 }]);
  });

  it('call() throws when the tool answered with an error text, so the script does not parse it as data', async () => {
    const codemode = { soql: async () => sap("Salesforce API Error (400): No such column 'CurrencyIsoCode' on entity 'Opportunity'") };
    const out = await run(`return rows(await call('soql', { query: 'x' }));`, codemode);
    expect(out.error).toContain('No such column');
    expect(out.steps[0].error).toContain('Salesforce API Error (400)');
  });
});
