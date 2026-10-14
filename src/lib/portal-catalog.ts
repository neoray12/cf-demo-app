/**
 * MCP Portal Code Mode exposes only portal_codemode_search / _execute, so the
 * model has to discover tool names itself — and often guesses wrong
 * (e.g. "salesforce_query_records"). We fetch the catalog once per connection
 * and put the callable names in the system prompt instead.
 */
export interface PortalCatalogEntry {
  name: string;
  description: string;
}

/** Search code that returns name + first description line for every tool. */
export const PORTAL_CATALOG_SEARCH_CODE =
  'async () => (await codemode.tools()).map(t => ({ name: t.name, description: (t.description || "").split("\\n")[0].slice(0, 120) }))';

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
      .filter((t): t is { name: string; description?: unknown } => !!t && typeof (t as { name?: unknown }).name === 'string')
      .map((t) => ({ name: t.name, description: String(t.description ?? '').split('\n')[0]!.trim() }));
  } catch {
    return [];
  }
}

export function formatPortalCatalog(serverName: string, tools: PortalCatalogEntry[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((t) => `- codemode.${t.name}(args)${t.description ? ` — ${t.description}` : ''}`);
  return (
    `\n\n## MCP Portal Code Mode：${serverName}\n` +
    '這個連線只有 portal_codemode_search / portal_codemode_execute 兩個工具。下列是在 portal_codemode_execute 的程式碼裡可以呼叫的工具，名稱已確認：' +
    '直接寫 `async () => { … await codemode.<name>({…}) … }` 執行，不要猜其他名稱；只有不確定參數時才用 portal_codemode_search 查 inputSchema。' +
    'Salesforce 工具回傳物件（例如 { summary, totalSize, records: [...] } 或 { summary, record }），可以直接計算後 return 結果。\n' +
    lines.join('\n') +
    '\n'
  );
}
