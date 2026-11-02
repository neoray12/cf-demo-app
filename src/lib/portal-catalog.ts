/**
 * MCP Portal Code Mode exposes only portal_codemode_search / _execute, so the
 * model has to discover tool names itself — and often guesses wrong
 * (e.g. "salesforce_query_records"). We fetch the catalog once per connection
 * and put the callable names in the system prompt instead.
 */
export interface PortalCatalogEntry {
  name: string;
  description: string;
  /** Argument names from inputSchema; optional ones end with "?". */
  params?: string[];
}

/**
 * Search code that returns, for every tool, its name, first description line
 * and argument names (from inputSchema) — enough to call it without a
 * portal_codemode_search round trip of its own.
 */
export const PORTAL_CATALOG_SEARCH_CODE =
  'async () => (await codemode.tools()).map(t => {' +
  ' const s = t.inputSchema || {}; const req = s.required || [];' +
  ' return { name: t.name, description: (t.description || "").split("\\n")[0].slice(0, 120),' +
  ' params: Object.keys(s.properties || {}).map(k => req.includes(k) ? k : k + "?") }; })';

export function isPortalCodeModeUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get('codemode') === 'search_and_execute';
  } catch {
    return false;
  }
}

export function parsePortalCatalog(text: string): PortalCatalogEntry[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is { name: string; description?: unknown; params?: unknown } => !!t && typeof (t as { name?: unknown }).name === 'string')
      .map((t) => ({
        name: t.name,
        description: String(t.description ?? '').split('\n')[0]!.trim(),
        ...(Array.isArray(t.params) ? { params: t.params.filter((p): p is string => typeof p === 'string') } : {}),
      }));
  } catch {
    return [];
  }
}

export function formatPortalCatalog(serverName: string, tools: PortalCatalogEntry[], executeTool = 'portal_codemode_execute'): string {
  if (tools.length === 0) return '';
  const args = (t: PortalCatalogEntry) => (t.params ? (t.params.length ? `{ ${t.params.join(', ')} }` : '{}') : 'args');
  const lines = tools.map((t) => `- ${t.name}(${args(t)})${t.description ? ` — ${t.description}` : ''}`);
  return (
    `\n\n## MCP Portal Code Mode：${serverName}\n` +
    `用 \`${executeTool}\` 執行一段 JS（\`async () => { … }\`），在裡面呼叫下列工具（名稱與參數已確認，? 是選填），不需要 portal_codemode_search。\n` +
    '一次 execute 做完整個任務：取清單 → Promise.all 並行查明細 → 在腳本裡算完（加權、加總、比率、排名、跨系統比對）→ 只 return 最後要呈現的列（每列 3–8 個欄位，結果盡量在 3,000 字元內）。' +
    '不要 return 原始 records、get_* 的完整 record 或工具原文。\n' +
    'App 已預先定義下列函式，直接使用，不要自己重寫：\n' +
    "- `await call(name, args)`：呼叫工具（記錄步驟給使用者看；工具回錯誤時會 throw），例如 `await call('sap_mcp_sap_list_sales_orders', {})`\n" +
    '- `rows(r)`：清單結果 → 物件陣列。Salesforce 取 `records`；SAP 每行 `- <id>: K=V, …` 變成 `{ id, K: \'V\', … }`（值是字串），引號裡的品名在 `text`，不是 K=V 的部分在 `parts`（陣列）與 `name`\n' +
    "- `fields(r)`：明細結果 → 物件。Salesforce 取 `record`；SAP 的 `Key: Value` 行變成 `{ 'Key': 'Value' }`；明細裡的子清單（Addresses、Items…）用 `rows(r)`\n" +
    '- `all(name, args)`：用 top/skip 自動分頁取完整清單，直接回傳 rows\n' +
    "- `num(v)`：'31250.00 USD' → 31250；`text(r)`：工具原文\n" +
    '腳本要短：不要註解、不要自己寫 regex 解析或正規化函式、不要 try/catch、不要先跑一個只看格式的腳本。' +
    '腳本成功回傳結果後就結束——0 筆、沒有對到也是正常結果，照實回報，不要再跑驗證或看樣本的腳本；只有回傳 error 或缺了任務要的欄位才重寫。\n' +
    'Salesforce 清單工具只回固定欄位（不含 AccountId、IsClosed）：sf_list_accounts `Id, Name, Industry, Phone, Website, BillingCity, BillingCountry, AnnualRevenue, NumberOfEmployees`；' +
    'sf_list_opportunities `Id, Name, StageName, Amount, CloseDate, Probability, Account.Name`；sf_list_cases `Id, CaseNumber, Subject, Status, Priority, Origin, Account.Name, Contact.Name`。' +
    '依 Account 彙總、篩選或排名時直接用 sf_soql_query（例如 `SELECT AccountId, COUNT(Id) n, SUM(Amount) amt FROM Opportunity GROUP BY AccountId`，欄位名就是別名），比逐筆 get 快。\n' +
    'SAP 格式（rows 之後的欄位名稱就是 = 左邊的字）：\n' +
    '- 銷售訂單 `- 6: Type=OR, Customer=17100011, Amount=31250.00 USD, Date=2026-09-08, Status=A`\n' +
    '- 訂單項目 `- Item 10: Product=FG126, "Finished Good 126, MTS, PD, Serial", Qty=25 PC, Net=31250.00 USD`\n' +
    '- 客戶 `- 17100001: <名稱> (Group: KUNA)`（名稱在 name）\n' +
    '- 生產訂單 `- 1000007: Material=FG126, Plant=1710, Qty=10 PC, Status=…, Start=2026-09-01`；工序 `- Op 0010/0: <描述>`；元件 `- RM122: Required=20 PC, Withdrawn=0, Plant=1710, StorageLoc=171A`\n' +
    '- 業務夥伴的地址 `  - <id>: 街道, 城市, 郵遞區號, 國家`（國家是 parts 的最後一個）\n' +
    '工具：\n' +
    lines.join('\n') +
    '\n'
  );
}

// Defined ahead of the model's script (see withStepLog): the step log, plus
// parsers for the two result shapes so a script does not re-implement them.
const SCRIPT_HELPERS = `const steps = [];
const text = (r) => Array.isArray(r) ? r.map((x) => (x && x.text) || '').join('\\n') : typeof r === 'string' ? r : JSON.stringify(r);
const num = (v) => { const m = String(v ?? '').replace(/,/g, '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : 0; };
const rows = (r) => {
  if (r && Array.isArray(r.records)) return r.records;
  if (r && r.record) return [r.record];
  return text(r).split('\\n').filter((l) => /^\\s*- /.test(l)).map((l) => {
    let s = l.trim().slice(2);
    const o = {};
    const q = s.match(/"([^"]*)"/);
    if (q) { o.text = q[1]; s = s.replace(q[0], ''); }
    const g = s.match(/\\s*\\(Group: ([^)]*)\\)/);
    if (g) { o.Group = g[1]; s = s.replace(g[0], ''); }
    const i = s.indexOf(': ');
    if (i < 0) return { ...o, name: s.trim() };
    o.id = s.slice(0, i).replace(/^(Item|Op|Plant|Address) /, '').trim();
    const parts = [];
    for (const p of s.slice(i + 2).split(/,\\s*/)) {
      const kv = p.match(/^([A-Za-z][\\w ]*?)=(.*)$/);
      if (kv) o[kv[1]] = kv[2].trim();
      else if (p.trim()) parts.push(p.trim());
    }
    if (parts.length) { o.parts = parts; o.name = parts.join(', '); }
    return o;
  });
};
const fields = (r) => {
  if (r && r.record) return r.record;
  const o = {};
  for (const l of text(r).split('\\n')) {
    const m = l.match(/^\\s*([A-Za-z][\\w ./]*?):\\s+(.+)$/);
    if (m && !(m[1] in o)) o[m[1]] = m[2].trim();
  }
  return o;
};
const TOOL_ERROR = /^(SAP API Error|Salesforce (API |OAuth )?Error|Salesforce .* timed out|Unknown error|Error\\b)/i;
const call = async (tool, args = {}) => {
  const t0 = Date.now();
  try {
    const r = await codemode[tool](args);
    if (r && r.isError) throw new Error(text(r.content ?? r).slice(0, 300));
    if (Array.isArray(r) && TOOL_ERROR.test(text(r).trim())) throw new Error(text(r).trim().slice(0, 300));
    const n = r && (Array.isArray(r.records) || r.record) ? rows(r).length : Array.isArray(r) ? rows(r).length : undefined;
    steps.push({ tool, args, n, ms: Date.now() - t0 });
    return r;
  } catch (e) {
    steps.push({ tool, args, error: String(e?.message ?? e), ms: Date.now() - t0 });
    throw e;
  }
};
const all = async (tool, args = {}, size = 100) => {
  const out = [];
  for (let skip = 0; skip < 5000; skip += size) {
    const r = await call(tool, { ...args, top: size, skip });
    const rs = rows(r);
    out.push(...rs);
    const total = r && r.totalSize != null ? r.totalSize : num((text(r).match(/Found (\\d+)/) || [])[1]);
    if (rs.length < size || (total && out.length >= total)) break;
  }
  return out;
};
`;

/**
 * Wraps the model's Code Mode script before it goes to the Portal: defines
 * `call()`, which logs every tool call, and the result parsers (SCRIPT_HELPERS),
 * and returns `{ steps, result }` (or `{ steps, error }`), so the model no
 * longer writes them into every script. A script that defines its own `call`
 * is left as it is.
 */
export function withStepLog(code: string): string {
  if (/\b(?:const|let|var)\s+call\s*=|\bfunction\s+call\s*\(/.test(code)) return code;
  const body = code.trim().replace(/;+\s*$/, '');
  const fn = /^\(*\s*(?:async\b|\([^)]*\)\s*=>|function\b)/.test(body) ? body : `async () => {\n${body}\n}`;
  return (
    'async () => {\n' +
    SCRIPT_HELPERS +
    `const script = (${fn});\n` +
    'try {\n  return { steps, result: await script() };\n} catch (e) {\n  return { steps, error: String(e?.message ?? e) };\n}\n}'
  );
}

/** Arguments for an MCP tool call; a Portal Code Mode script gets the step-log wrapper. */
export function prepareCodeModeArgs<T extends Record<string, unknown>>(toolName: string, args: T): T {
  if (!toolName.endsWith('portal_codemode_execute') || typeof args.code !== 'string') return args;
  return { ...args, code: withStepLog(args.code) };
}

type ModelOutput = { type: 'text'; value: string } | { type: 'json'; value: unknown };

/**
 * What the model sees of a Code Mode execute result: only the script's result,
 * as compact JSON. The Portal pretty-prints it and the step log (shown in the
 * UI) repeats every call's arguments — both cost input tokens on every later step.
 */
export function codeModeModelOutput(output: unknown): ModelOutput {
  const o = output as { result?: unknown } | null;
  if (!o || typeof o.result !== 'string') return { type: 'json', value: output };
  let v: unknown;
  try {
    v = JSON.parse(o.result);
  } catch {
    return { type: 'json', value: output };
  }
  if (!v || typeof v !== 'object' || !Array.isArray((v as { steps?: unknown }).steps)) return { type: 'text', value: JSON.stringify(v) };
  const { steps, ...rest } = v as { steps: Array<{ tool?: string; args?: unknown; error?: string }>; error?: string; result?: unknown };
  if ('error' in rest && !('result' in rest)) {
    const failedCalls = steps.filter((s) => s.error).map((s) => ({ tool: s.tool, args: s.args, error: s.error }));
    return { type: 'text', value: JSON.stringify({ error: rest.error, failedCalls, completedCalls: steps.length - failedCalls.length }) };
  }
  return { type: 'text', value: JSON.stringify('result' in rest ? rest.result : rest) ?? 'null' };
}
