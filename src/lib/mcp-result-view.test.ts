import { describe, expect, it } from 'vitest';
import { viewMcpResult } from './mcp-result-view';

describe('viewMcpResult', () => {
  it('turns a portal_codemode_search tool list into rows', () => {
    const result = JSON.stringify([
      { name: 'salesforce_mcp_sf_list_accounts', description: '搜尋並列出公司/組織帳戶', params: ['search', 'top'] },
      { name: 'salesforce_mcp_sf_get_account', description: '取得單一帳戶完整資料', params: ['account_id'] },
    ], null, 2);
    expect(viewMcpResult({ source: 'SAP & Salesforce (Code Mode)', result })).toEqual({
      source: 'SAP & Salesforce (Code Mode)',
      kind: 'toolList',
      tools: [
        { name: 'salesforce_mcp_sf_list_accounts', description: '搜尋並列出公司/組織帳戶', params: ['search', 'top'] },
        { name: 'salesforce_mcp_sf_get_account', description: '取得單一帳戶完整資料', params: ['account_id'] },
      ],
    });
  });

  it('unwraps MCP content blocks into their text', () => {
    const result = JSON.stringify([{ type: 'text', text: '帳戶共 10 筆：\n- Edge Communications' }, { type: 'text', text: 'second' }]);
    expect(viewMcpResult({ source: 's', result })).toEqual({ source: 's', kind: 'text', text: '帳戶共 10 筆：\n- Edge Communications\n\nsecond' });
  });

  it('keeps plain text as text', () => {
    expect(viewMcpResult({ source: 's', result: '聯絡人共 20 筆:\n- Rose' })).toEqual({ source: 's', kind: 'text', text: '聯絡人共 20 筆:\n- Rose' });
  });

  it('flags "Error:" results', () => {
    expect(viewMcpResult({ source: 's', result: 'Error: Tool "x" not found' })).toEqual({ source: 's', kind: 'error', text: 'Error: Tool "x" not found' });
  });

  it('pretty-prints other JSON', () => {
    expect(viewMcpResult({ source: 's', result: '{"a":1}' })).toEqual({ source: 's', kind: 'json', text: '{\n  "a": 1\n}' });
  });

  it('shows the wrapper error of a failed call', () => {
    expect(viewMcpResult({ error: 'MCP tool failed: boom' })).toEqual({ kind: 'error', text: 'MCP tool failed: boom' });
  });

  it('falls back to JSON for unknown shapes', () => {
    expect(viewMcpResult({ foo: 1 })).toEqual({ kind: 'json', text: '{\n  "foo": 1\n}' });
  });
});

describe('viewMcpResult records', () => {
  const data = { summary: '帳戶共 2 筆（顯示 2）', totalSize: 2, records: [
    { Id: '001A', Name: 'Edge', Industry: 'Electronics', Owner: { Name: 'Neo' } },
    { Id: '001B', Name: 'Burlington', Phone: '(336) 222-7000' },
  ] };
  const expected = {
    kind: 'records',
    summary: '帳戶共 2 筆（顯示 2）',
    columns: ['Id', 'Name', 'Industry', 'Owner', 'Phone'],
    rows: [['001A', 'Edge', 'Electronics', 'Neo', ''], ['001B', 'Burlington', '', '', '(336) 222-7000']],
  };

  it('renders structured { summary, records } results (app side) as a table', () => {
    expect(viewMcpResult({ source: 's', result: data })).toEqual({ source: 's', ...expected });
  });

  it('renders the same JSON returned as text (portal side) as a table', () => {
    expect(viewMcpResult({ source: 's', result: JSON.stringify(data) })).toEqual({ source: 's', ...expected });
  });

  it('shows a single { summary, record } as a one-row table', () => {
    expect(viewMcpResult({ source: 's', result: { summary: '名稱: Edge', record: { Id: '001A', Name: 'Edge' } } })).toEqual({
      source: 's', kind: 'records', summary: '名稱: Edge', columns: ['Id', 'Name'], rows: [['001A', 'Edge']],
    });
  });
});
