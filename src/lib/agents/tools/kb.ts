// Knowledge-base search tool. Span start/end come from the runtime's execute wrapper (or runTracedTool for the
// run's prefetch); this module only emits citations (keyed by the tool span id) and span attributes.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { errorMessage, type RunContext } from "../runtime";
import { isValidWorkspace, kbSearch } from "../kb";
import { setActiveSpanAttributes } from "../tracing";

export const KB_NOT_FOUND_INSTRUCTION = "知識庫中沒有相關資料。請明確回覆找不到，不要用一般知識作答。";

export type KbSearchOutput =
  | { results: Array<{ n: number; filename: string; score: number; snippet: string; sourceUrl: string | null }> }
  | { results: []; instruction: string }
  | { results: []; error: string };

const COUNTER_KEY = Symbol("kb-citation-counter");

/**
 * Source numbers [n] continue across every search of a run — the prefetch takes [1..n] and a follow-up search_kb
 * continues from there — so the final answer's citations stay unambiguous. Shared through the run scope (the
 * prefetch and the tools both see the root RunContext's scope); without a scope, per `fallback` object.
 */
function citationCounter(ctx: RunContext, fallback: { n: number }): { n: number } {
  return ctx.scope?.once(COUNTER_KEY, () => ({ n: 0 }), () => {}) ?? fallback;
}

/** One knowledge-base search with run-wide numbering; citations are emitted under `spanId`. */
export async function searchKbNumbered(
  ctx: RunContext,
  query: string,
  maxResults: number,
  spanId: string,
  counter: { n: number },
  search: typeof kbSearch = kbSearch,
): Promise<KbSearchOutput> {
  const workspace = ctx.workspace ?? "default";
  if (!isValidWorkspace(workspace)) return { results: [], error: `invalid workspace: ${workspace}` };
  let found: Awaited<ReturnType<typeof kbSearch>>;
  try {
    found = await search(ctx.env, workspace, query, maxResults, ctx.signal);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { results: [], error: `知識庫搜尋失敗：${errorMessage(err)}` };
  }
  setActiveSpanAttributes({ "kb.results": found.results.length, "kb.top_score": found.topScore });
  if (found.results.length === 0) return { results: [], instruction: KB_NOT_FOUND_INSTRUCTION };
  const results = found.results.map((r) => ({ n: ++counter.n, ...r }));
  for (const r of results) {
    ctx.emit({
      type: "citation",
      spanId,
      source: { title: r.filename, ...(r.sourceUrl ? { url: r.sourceUrl } : {}), snippet: r.snippet, score: r.score },
    });
  }
  return { results };
}

/** The run-wide citation counter of `ctx` (see citationCounter). */
export function kbCounter(ctx: RunContext): { n: number } {
  return citationCounter(ctx, { n: 0 });
}

export function buildKbTools(ctx: RunContext, search: typeof kbSearch = kbSearch): ToolSet {
  const counter = citationCounter(ctx, { n: 0 });
  return {
    search_kb: tool({
      description:
        "Search the company knowledge base (the user's uploaded documents). Returns numbered passages with filename, score and snippet. Rewrite the query into keywords (Chinese and/or English) if the first search finds nothing.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
        maxResults: z.number().int().min(1).max(10).optional().describe("Maximum passages to return (default 5)"),
      }),
      execute: async ({ query, maxResults }, options) =>
        searchKbNumbered(ctx, query, maxResults ?? 5, options.toolCallId, counter, search),
    }),
  };
}
