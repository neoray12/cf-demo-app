// Knowledge-base search tool. Span start/end come from the runtime's execute wrapper; this tool only
// emits citations (keyed by the namespaced options.toolCallId) and span attributes.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { errorMessage, type RunContext } from "../runtime";
import { isValidWorkspace, kbSearch } from "../kb";
import { setActiveSpanAttributes } from "../tracing";

export const KB_NOT_FOUND_INSTRUCTION = "知識庫中沒有相關資料。請明確回覆找不到，不要用一般知識作答。";

export function buildKbTools(ctx: RunContext, search: typeof kbSearch = kbSearch): ToolSet {
  // Source numbers [n] continue across search_kb calls so the final answer's citations stay unambiguous.
  let counter = 0;
  return {
    search_kb: tool({
      description:
        "Search the company knowledge base (the user's uploaded documents). Returns numbered passages with filename, score and snippet. Rewrite the query into keywords (Chinese and/or English) if the first search finds nothing.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
        maxResults: z.number().int().min(1).max(10).optional().describe("Maximum passages to return (default 5)"),
      }),
      execute: async ({ query, maxResults }, options) => {
        const workspace = ctx.workspace ?? "default";
        if (!isValidWorkspace(workspace)) return { results: [], error: `invalid workspace: ${workspace}` };
        let found: Awaited<ReturnType<typeof kbSearch>>;
        try {
          found = await search(ctx.env, workspace, query, maxResults ?? 5, ctx.signal);
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return { results: [], error: `知識庫搜尋失敗：${errorMessage(err)}` };
        }
        setActiveSpanAttributes({ "kb.results": found.results.length, "kb.top_score": found.topScore });
        if (found.results.length === 0) return { results: [], instruction: KB_NOT_FOUND_INSTRUCTION };
        const results = found.results.map((r) => ({ n: ++counter, ...r }));
        for (const r of results) {
          ctx.emit({
            type: "citation",
            spanId: options.toolCallId,
            source: { title: r.filename, ...(r.sourceUrl ? { url: r.sourceUrl } : {}), snippet: r.snippet, score: r.score },
          });
        }
        return { results };
      },
    }),
  };
}
