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
);

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

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
    if (typeof r.result === 'string') {
      const view = viewText(r.result);
      return typeof r.source === 'string' ? { source: r.source, ...view } : view;
    }
  }
  return { kind: 'json', text: pretty(raw) };
}
