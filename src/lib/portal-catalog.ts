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

export function formatPortalCatalog(serverName: string, tools: PortalCatalogEntry[]): string {
  if (tools.length === 0) return '';
  const args = (t: PortalCatalogEntry) => (t.params ? (t.params.length ? `{ ${t.params.join(', ')} }` : '{}') : 'args');
  const lines = tools.map((t) => `- codemode.${t.name}(${args(t)})${t.description ? ` — ${t.description}` : ''}`);
  return (
    `\n\n## MCP Portal Code Mode：${serverName}\n` +
    '這個連線只有 portal_codemode_search / portal_codemode_execute 兩個工具。下列是在 portal_codemode_execute 的程式碼裡可以呼叫的工具，名稱與參數已確認（? 是選填）：' +
    '直接寫 `async () => { … await codemode.<name>({…}) … }` 執行，不要猜其他名稱，也不需要先用 portal_codemode_search。\n' +
    '盡量用一次 portal_codemode_execute 做完整個任務：先取清單，再用 Promise.all 並行查每一筆明細，在程式裡完成篩選、加總、排序，' +
    '只 return 回答需要的最終結果（彙總數字、前幾名、表格列），不要 return 原始 records——原始資料留在程式裡，不會佔用對話 token。' +
    '工具回傳有兩種形狀：Salesforce 回傳物件（{ summary, totalSize, records: [...] } 或 { summary, record }），可以直接計算；' +
    "SAP 回傳 MCP 文字陣列 [{ type: 'text', text }]，內容是一行一筆（例如 \"Found 6 sales orders (showing 6):\\n- 6: Type=OR, Customer=17100011, Amount=31250.00 USD, Date=2026-09-08\"）——" +
    "先 `const t = Array.isArray(r) ? r.map((x) => x.text).join('\\n') : String(r)`，再用正規表示式逐行解析欄位。\n" +
    '每一個工具呼叫都要經過下面這個 call 記錄步驟（畫面會把 steps 畫成表格給使用者看），腳本開頭先貼上：\n' +
    '```js\n' +
    'const steps = [];\n' +
    'const call = async (tool, args = {}) => {\n' +
    '  const t0 = Date.now();\n' +
    '  try {\n' +
    '    const r = await codemode[tool](args);\n' +
    "    const n = Array.isArray(r?.records) ? r.records.length : Array.isArray(r) ? r.map((x) => x.text).join('\\n').split('\\n').filter((l) => l.startsWith('- ')).length : undefined;\n" +
    '    steps.push({ tool, args, n, ms: Date.now() - t0 });\n' +
    '    return r;\n' +
    '  } catch (e) {\n' +
    '    steps.push({ tool, args, error: String(e?.message ?? e), ms: Date.now() - t0 });\n' +
    '    throw e;\n' +
    '  }\n' +
    '};\n' +
    '```\n' +
    "然後用 `await call('<name>', { … })` 取代 `await codemode.<name>({ … })`（Promise.all 裡也一樣），最後 `return { steps, result: { … } }`（steps 放前面）。\n" +
    lines.join('\n') +
    '\n'
  );
}
