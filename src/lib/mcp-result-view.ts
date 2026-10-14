/**
 * How to show an MCP tool result in the chat. The server wraps MCP results as
 * { source, result } where `result` is the tool's text — which for the MCP
 * Portal's Code Mode tools is itself JSON (a tool list, or MCP content blocks).
 */
export interface McpToolRow {
  name: string;
  description?: string;
  params: string[];
}

export type McpResultView = { source?: string } & (
  | { kind: 'toolList'; tools: McpToolRow[] }
  | { kind: 'text'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'json'; text: string }
  | { kind: 'records'; summary?: string; columns: string[]; rows: string[][] }
);

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function cell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const name = (v as { Name?: unknown }).Name;
    return typeof name === 'string' ? name : JSON.stringify(v);
  }
  return String(v);
}

/** { summary?, records: [...] } or { summary?, record: {...} } → a table, else null. */
function viewRecords(v: unknown): McpResultView | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { summary?: unknown; records?: unknown; record?: unknown };
  const list = Array.isArray(o.records) ? o.records : o.record && typeof o.record === 'object' ? [o.record] : null;
  if (!list || !list.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return null;
  const columns: string[] = [];
  for (const r of list as Record<string, unknown>[]) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  return {
    kind: 'records',
    ...(typeof o.summary === 'string' ? { summary: o.summary } : {}),
    columns,
    rows: (list as Record<string, unknown>[]).map((r) => columns.map((c) => cell(r[c]))),
  };
}

function isToolList(v: unknown): v is Array<{ name: string; description?: string; params?: unknown }> {
  return Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string');
}

function isContentBlocks(v: unknown): v is Array<{ type: string; text?: string }> {
  return Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string');
}

function viewText(text: string): McpResultView {
  const trimmed = text.trim();
  if (/^error\b/i.test(trimmed)) return { kind: 'error', text: trimmed };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isToolList(parsed)) {
        return {
          kind: 'toolList',
          tools: parsed.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            params: Array.isArray(t.params) ? t.params.map(String) : [],
          })),
        };
      }
      const records = viewRecords(parsed);
      if (records) return records;
      if (isContentBlocks(parsed)) {
        const inner = parsed.filter((b) => b.type === 'text' && b.text).map((b) => b.text!).join('\n\n');
        return viewText(inner);
      }
      return { kind: 'json', text: pretty(parsed) };
    } catch {
      /* not JSON — show as text */
    }
  }
  return { kind: 'text', text };
}

export function viewMcpResult(raw: unknown): McpResultView {
  if (typeof raw === 'string') return viewText(raw);
  if (raw && typeof raw === 'object') {
    const r = raw as { source?: unknown; result?: unknown; error?: unknown };
    if (typeof r.error === 'string' && r.result === undefined) return { kind: 'error', text: r.error };
    const view = typeof r.result === 'string' ? viewText(r.result) : viewRecords(r.result);
    if (view) return typeof r.source === 'string' ? { source: r.source, ...view } : view;
    if (r.result !== undefined && typeof r.source === 'string') return { source: r.source, kind: 'json', text: pretty(r.result) };
  }
  return { kind: 'json', text: pretty(raw) };
}
