// Cloudflare docs agent — lean flow (about 3 sequential model waits for a complex question):
//   t=0   prefetch: translate_query (CJK → English keywords) → search_docs → rerank_results (top 3, trimmed), as
//         traced tool spans under the root (runs alongside step 0)
//   step 0 the root writes a one-line plan (R16) and calls research({ questions: 2–3 }) or overview()
//          research → parallel docs-researchers, each = [translate_query if CJK] → search_docs → rerank_results spans
//          + ONE no-tool model call over the 3 kept hits
//   step 1 the root writes the answer from the findings (+ the prefetched overview results)
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { languageInstruction, type UserLanguage } from "../language";
import { ctxLanguage, runParallel, runSubagent, runTracedTool, type AgentDef, type RunContext, type SubagentDef } from "../runtime";
import { buildDocsTools, formatDocsHits, searchDocsHits, type DocsSearchHit } from "../tools/cf-docs";
import { compressDocsHits, hasCjk, translateDocsQuery, type Reranker } from "../tools/docs-query";

/** Hits kept after reranking, for the overview and for each researcher. */
export const DOCS_TOP_K = 3;
const QUERY_MAX_CHARS = 400;

type DocsSearchOutcome = { results: DocsSearchHit[]; error?: string };

/** Test seam: the reranker used by searchAndCompress (defaults to Workers AI bge-reranker-base). */
export const docsDeps: { rerank?: Reranker } = {};

/**
 * One deterministic docs lookup as traced tool spans under `parentSpanId`:
 * [`{parent}/translate` translate_query, when `translate`] → `{parent}/{searchCallId}` search_docs (all hits, no
 * citations; a translated query with 0 hits is retried as written) → `{parent}/rerank` rerank_results (top DOCS_TOP_K, snippets ≤ 700 chars; only the KEPT hits are
 * emitted as citations, under the rerank span). A failed search skips the rerank; a failed rerank falls back to
 * the first hits.
 */
export async function searchAndCompress(
  ctx: RunContext,
  parentSpanId: string,
  text: string,
  opts: { translate: boolean; searchCallId: string },
): Promise<DocsSearchOutcome> {
  const raw = text.trim().slice(0, QUERY_MAX_CHARS);
  const query = opts.translate
    ? (
        await runTracedTool(ctx, parentSpanId, "translate_query", { text: raw }, async () => translateDocsQuery(raw), {
          callId: "translate",
        })
      ).query
    : raw;
  // The span output is a compact summary (hit count + titles); the full hits stay in `found` for the reranker.
  const found: DocsSearchOutcome = { results: [] };
  await runTracedTool(
    ctx,
    parentSpanId,
    "search_docs",
    { query },
    async () => {
      let r = await searchDocsHits(ctx, query);
      let fallbackQuery: string | undefined;
      // The docs search has a relevance cut-off: a translated query that finds nothing is retried as written.
      if (!r.error && r.hits.length === 0 && query !== raw) {
        fallbackQuery = raw;
        r = await searchDocsHits(ctx, raw);
      }
      found.results = r.hits;
      if (r.error) found.error = r.error;
      return {
        hits: r.hits.length,
        cacheHit: r.cacheHit,
        titles: r.hits.map((h) => h.title),
        ...(fallbackQuery ? { fallbackQuery } : {}),
        ...(r.error ? { error: r.error } : {}),
      };
    },
    { callId: opts.searchCallId, failed: (res) => res.error },
  );
  let kept: DocsSearchHit[] = [];
  await runTracedTool(
    ctx,
    parentSpanId,
    "rerank_results",
    { query, hits: found.results.length, topK: DOCS_TOP_K },
    async (spanId) => {
      const c = await compressDocsHits(ctx, query, found.results, DOCS_TOP_K, { citeSpanId: spanId, rerank: docsDeps.rerank });
      kept = c.hits;
      return {
        kept: c.kept,
        dropped: c.dropped,
        topScores: c.topScores,
        reranked: c.reranked,
        urls: c.hits.map((h) => h.url),
        ...(c.error ? { fallback: c.error } : {}),
      };
    },
    { callId: "rerank" },
  );
  return { results: kept };
}

export const docsResearcher: SubagentDef<{ question: string; language?: UserLanguage }> = {
  functionId: "docs-researcher",
  model: "glm-5.3-flash", // the run's model (ctx.modelKey, no-think variant) overrides this
  maxSteps: 1,
  system: [
    "You are a Cloudflare documentation researcher.",
    "You are given the results of one search of the official Cloudflare documentation for a sub-question.",
    "Summarize what they say about the sub-question in at most 5 one-sentence bullet points, and put the source URL after each bullet.",
    "Write the bullets in the output language given in the prompt (translate the English documentation into it); keep product names, code, API names and URLs unchanged.",
    "Use ONLY these search results; never use outside knowledge. If they do not cover the sub-question, say so in one line.",
    "Reply with plain text only.",
  ].join(" "),
  tools: () => ({}),
  prompt: ({ question, language }) =>
    `Sub-question: ${question}${language ? `\n${languageInstruction(language)}` : ""}`,
  // One deterministic lookup inside the researcher's own invoke_agent span (translated when the sub-question is
  // CJK, reranked to the top 3); only the kept hits go into the prompt.
  prepare: async ({ question }, ctx, spanId) => {
    const r = await searchAndCompress(ctx, spanId, question, { translate: hasCjk(question), searchCallId: "search" });
    if (r.error) return `Documentation search failed: ${r.error}`;
    if (r.results.length === 0) return "Documentation search results: (none)";
    return `Documentation search results:\n\n${formatDocsHits(r.results)}`;
  },
};

/** The prefetched overview search (awaits it if it is still running). */
async function prefetchedDocs(ctx: RunContext): Promise<DocsSearchOutcome> {
  const pre = ctx.prefetched ? await ctx.prefetched : undefined;
  const data = pre?.data as DocsSearchOutcome | undefined;
  if (!data) return { results: [], error: "overview search failed" };
  return data;
}

function docsAgentTools(ctx: RunContext): ToolSet {
  const { read_doc_page } = buildDocsTools(ctx, { withRead: true, withSearch: false });
  return {
    overview: tool({
      description:
        "Get the documentation search results for the user's question (already searched when the run started). Use this for simple, single-topic questions.",
      inputSchema: z.object({}),
      execute: async () => prefetchedDocs(ctx),
    }),
    research: tool({
      description:
        "Research 2-3 sub-questions in parallel with dedicated documentation researchers (one docs search + summary each). Use only for comparisons or multi-part questions. Also returns the overview search results for the user's question.",
      inputSchema: z.object({
        questions: z
          .array(z.string().min(1))
          .min(2)
          .max(3)
          .describe("2-3 self-contained sub-questions, written in English with official Cloudflare product names, each searchable on its own"),
      }),
      execute: async ({ questions }, options) => {
        const [{ ok, failed }, overview] = await Promise.all([
          runParallel(
            questions.map((question, i) => ({
              name: question,
              run: () => runSubagent(docsResearcher, { question, language: ctxLanguage(ctx) }, ctx, options.toolCallId, i),
            })),
          ),
          prefetchedDocs(ctx),
        ]);
        const answered = ok.filter((r) => r.value.text.trim() !== "");
        const empty = ok
          .filter((r) => r.value.text.trim() === "")
          .map((r) => ({ name: r.name, error: "no answer" }));
        return {
          findings: answered.map((r) => ({ question: r.name, summary: r.value.text })),
          failed: [...failed, ...empty],
          overview,
        };
      },
    }),
    read_doc_page: read_doc_page!,
  };
}

export const docsAgent: AgentDef = {
  id: "cloudflare-docs",
  functionId: "docs-agent",
  defaultModel: "glm-5.3-flash",
  // step 0: plan + research/overview; step 1: answer; one spare step (R23 forces the answer on the last one)
  maxSteps: 3,
  system: () =>
    [
      "你是「Cloudflare 文件專家」，只根據官方 Cloudflare 文件回答問題。",
      "【第一步】先用使用者提問的語言寫一句簡短的計畫（不超過 40 字，例如：「我會分別查 Workers 與 Pages 的定位與限制，再整理比較。」），然後在同一步呼叫一個工具：",
      "- 比較、多個產品或多個面向的問題：呼叫 research，傳入 2–3 個彼此獨立、可單獨搜尋的子問題。子問題一律用英文撰寫，並使用 Cloudflare 官方產品名稱（例如 Workers、Pages、R2、D1、Workers KV、Durable Objects、Queues、AI Gateway、Workers AI），不要用中文俗稱（文件是英文的，中文查詢搜尋效果差）。",
      "- 簡單、單一主題的問題：呼叫 overview（系統已在一開始用使用者的問題搜尋過文件）。",
      "research 或 overview 回傳後，直接整合結果作答，不要再呼叫工具、不要重複計畫。research 的結果也包含 overview。",
      "read_doc_page 只在使用者明確要求某一頁的詳細內容、且摘要明顯不夠時才使用，一次最多讀一頁；一般問題不要讀頁面。",
      "只能依據工具回傳的內容作答，不要憑空補充；找不到就明說。",
      "請完全用使用者提問的語言作答（中文問題用繁體中文，英文問題用英文）：把研究員的發現與搜尋結果翻譯整合成該語言，絕對不要貼上未翻譯的英文段落（研究員或文件的原文）；產品名稱、程式碼、指令與網址保持原樣，並在相關段落附上文件連結。",
      "回答要精簡：先給一句結論，再用一個小表格或 3–6 個重點說明，全文約 300–600 字；不要重複工具結果的原文。",
      "如果 research 的 failed 不是空的，必須在回答中註明哪些子問題沒有查到結果。",
    ].join("\n"),
  tools: docsAgentTools,
  // t=0: the user's question → translate_query → search_docs → rerank_results, alongside the root's first model call
  prefetch: async (ctx, rootSpanId, userText) => {
    if (!userText.trim()) return { data: { results: [], error: "empty question" } satisfies DocsSearchOutcome };
    const r = await searchAndCompress(ctx, rootSpanId, userText, { translate: true, searchCallId: "prefetch" });
    return { data: r satisfies DocsSearchOutcome };
  },
  prefetchMode: "background",
};
