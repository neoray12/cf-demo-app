// Deterministic helpers for the Cloudflare docs agent (no LLM):
// - translateDocsQuery: Chinese question → English keyword query with official product names (the docs are English
//   and CJK queries search poorly);
// - compressDocsHits: rerank docs search hits with Workers AI bge-reranker-base, keep the top K and trim snippets,
//   so researchers / the root read 3 focused passages instead of 5–16 long ones.
import type { RunContext } from "../runtime";
import type { DocsSearchHit } from "./cf-docs";

const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

const COMPARE_TERMS = /比較|比较|差異|差异|差在|差別|差别|區別|区别|不同|\bvs\.?\b|versus/i;

interface GlossaryEntry {
  re: RegExp;
  /** Official Cloudflare product name, when the term names a product. */
  product?: string;
  /** English keywords added to the query. */
  keywords?: string[];
}

// Order matters only for the output order of products / keywords (first match first).
const GLOSSARY: GlossaryEntry[] = [
  { re: /AI\s*閘道|AI\s*闸道|AI\s*gateway/i, product: "AI Gateway" },
  { re: /Workers\s*AI|推論|推理|模型/i, product: "Workers AI" },
  { re: /邊緣運算|边缘运算|無伺服器|无服务器|serverless|\bWorkers?\b(?!\s*(?:AI|KV))/i, product: "Workers" },
  { re: /靜態網站|静态网站|前端部署|\bPages\b/i, product: "Pages" },
  { re: /物件儲存|对象存储|物件存儲|\bR2\b/i, product: "R2" },
  { re: /資料庫|数据库|\bD1\b/i, product: "D1" },
  { re: /鍵值|键值|\bKV\b/i, product: "Workers KV" },
  { re: /有狀態|有状态|協作|协作|Durable\s*Objects?/i, product: "Durable Objects" },
  { re: /佇列|队列|\bQueues?\b/i, product: "Queues" },
  { re: /向量|Vectorize/i, product: "Vectorize" },
  { re: /排程|排程任務|定時|cron/i, product: "Cron Triggers" },
  { re: /快取|缓存|\bcache\b/i, product: "Cache" },
  { re: /防火牆|防火墙|\bWAF\b/i, product: "WAF" },
  { re: /零信任|zero\s*trust/i, product: "Zero Trust" },
  { re: /隧道|tunnel/i, product: "Cloudflare Tunnel" },
  { re: /負載平衡|负载均衡|load\s*balanc/i, product: "Load Balancing" },
  { re: /機器人|机器人|bot\s*management/i, product: "Bot Management" },
  { re: /DDoS/i, product: "DDoS Protection" },
  { re: /憑證|证书|\bSSL\b|\bTLS\b/i, product: "SSL/TLS" },
  { re: /網域|域名|\bDNS\b/i, product: "DNS" },
  { re: /影片|视频|\bStream\b/i, product: "Stream" },
  { re: /圖片|图片|\bImages\b/i, product: "Images" },
  { re: /爬蟲|爬虫|瀏覽器|浏览器|browser\s*rendering/i, product: "Browser Rendering" },
  { re: /郵件|邮件|email\s*routing/i, product: "Email Routing" },
  { re: /限制|上限|配額|配额/, keywords: ["limits"] },
  { re: /價格|价格|費用|费用|收費|收费|計價|计价/, keywords: ["pricing"] },
  // comparison: "A vs B" when two or more products are named (see translateDocsQuery), else "comparison"
  { re: COMPARE_TERMS, keywords: ["comparison"] },
  { re: /新專案|新项目|新項目/, keywords: ["for a new project"] },
  { re: /如何|怎麼|怎么|怎樣|怎样|步驟|步骤/, keywords: ["how to"] },
  { re: /設定|设置|設置|配置/, keywords: ["configure"] },
  { re: /部署/, keywords: ["deploy"] },
  { re: /遷移|迁移|搬移/, keywords: ["migrate"] },
];

const LATIN_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9.+#_/-]*/g;
const QUERY_MAX_CHARS = 200;

export interface TranslatedDocsQuery {
  /** English keyword query for the docs search. */
  query: string;
  /** Official product names recognised in the text (in glossary order, de-duplicated). */
  products: string[];
}

/**
 * Chinese (or mixed) question → English keyword query: official product names + glossary keywords + the Latin
 * tokens already in the text (product names, APIs, code). A comparison of two or more products becomes
 * "A vs B" — the docs search is semantic with a relevance cut-off, and keyword soups like "Workers Pages comparison
 * vs which to choose" return nothing while "Workers vs Pages for a new project" returns 20 hits (measured
 * 2026-10-24). Text without CJK is returned unchanged as the query.
 */
export function translateDocsQuery(text: string): TranslatedDocsQuery {
  const trimmed = text.trim();
  const products: string[] = [];
  const keywords: string[] = [];
  for (const g of GLOSSARY) {
    if (!g.re.test(trimmed)) continue;
    if (g.product && !products.includes(g.product)) products.push(g.product);
    for (const k of g.keywords ?? []) if (!keywords.includes(k)) keywords.push(k);
  }
  if (!hasCjk(trimmed)) return { query: trimmed.slice(0, QUERY_MAX_CHARS), products };
  const versus = products.length >= 2 && keywords.includes("comparison");
  const words = versus ? [products.join(" vs "), ...keywords.filter((k) => k !== "comparison")] : [...products, ...keywords];
  const covered = new Set([...products, ...keywords].flatMap((w) => w.toLowerCase().split(/[\s/]+/)));
  covered.add("vs");
  for (const m of trimmed.matchAll(LATIN_TOKEN_RE)) {
    const token = m[0].replace(/[.\-_/]+$/, "");
    const lower = token.toLowerCase();
    if (!token || covered.has(lower)) continue;
    covered.add(lower);
    words.push(token);
  }
  const query = words.join(" ").slice(0, QUERY_MAX_CHARS).trim();
  return { query: query || trimmed.slice(0, QUERY_MAX_CHARS), products };
}

// ---------------------------------------------------------------------------
// Result compressor

export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
export const RERANK_TIMEOUT_MS = 10_000;
export const SNIPPET_KEEP_MAX = 700;
const RERANK_TEXT_MAX = 1500;
const STOP_WORDS = new Set(["how", "to", "vs", "the", "and", "or", "of", "a", "an", "in", "on", "for", "is", "what", "which", "with"]);

export type Reranker = (ctx: RunContext, query: string, texts: string[]) => Promise<Array<{ id: number; score: number }>>;

/** Workers AI REST: POST /ai/run/@cf/baai/bge-reranker-base {query, contexts:[{text}]} → result.response [{id, score}]. */
export const workersAiRerank: Reranker = async (ctx, query, texts) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ctx.env.CF_ACCOUNT_ID}/ai/run/${RERANK_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, contexts: texts.map((text) => ({ text })) }),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(RERANK_TIMEOUT_MS)]),
  });
  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: { response?: Array<{ id?: unknown; score?: unknown }> }; errors?: Array<{ message?: string }> }
    | null;
  const list = data?.result?.response;
  if (!res.ok || !Array.isArray(list)) {
    throw new Error(`rerank failed (${res.status}): ${data?.errors?.[0]?.message ?? "unexpected response"}`);
  }
  return list
    .filter((r): r is { id: number; score: number } => typeof r.id === "number" && typeof r.score === "number")
    .map((r) => ({ id: r.id, score: r.score }));
};

/** Query words worth locating in a snippet (≥ 2 chars, no stop words), longest first. */
function queryKeywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9㐀-鿿]+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

/** ≤ `max` chars of `text`, centred on the first occurrence of a query keyword when it isn't near the start. */
export function trimSnippet(text: string, query: string, max = SNIPPET_KEEP_MAX): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const lower = clean.toLowerCase();
  let at = -1;
  for (const k of queryKeywords(query)) {
    const i = lower.indexOf(k);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - Math.floor(max / 2));
  if (start + max >= clean.length) {
    // tail window: ends at the text's end
    const tailStart = Math.max(0, clean.length - (max - 1));
    return `${tailStart > 0 ? "…" : ""}${clean.slice(tailStart)}`;
  }
  const prefix = start > 0 ? "…" : "";
  return `${prefix}${clean.slice(start, start + max - prefix.length - 1)}…`;
}

export interface CompressedDocs {
  hits: DocsSearchHit[];
  kept: number;
  dropped: number;
  topScores: number[];
  reranked: boolean;
  error?: string;
}

/**
 * Rerank docs search hits against `query` (Workers AI bge-reranker-base), keep the top `topK` and trim each
 * snippet to ≤ 700 chars. A reranker failure falls back to the first `topK` hits (never throws, except on abort).
 * With `citeSpanId`, the KEPT hits are emitted as citations of that span (dropped hits are never cited).
 */
export async function compressDocsHits(
  ctx: RunContext,
  query: string,
  hits: DocsSearchHit[],
  topK = 3,
  opts: { citeSpanId?: string; rerank?: Reranker } = {},
): Promise<CompressedDocs> {
  let order: Array<{ index: number; score?: number }> = hits.map((_, index) => ({ index }));
  let reranked = false;
  let error: string | undefined;
  if (hits.length > topK) {
    try {
      const texts = hits.map((h) => `${h.title}\n${h.snippet}`.slice(0, RERANK_TEXT_MAX));
      const scores = await (opts.rerank ?? workersAiRerank)(ctx, query, texts);
      const valid = scores.filter((s) => Number.isInteger(s.id) && s.id >= 0 && s.id < hits.length);
      if (valid.length === 0) throw new Error("rerank returned no scores");
      const seen = new Set<number>();
      const ranked = [...valid]
        .sort((a, b) => b.score - a.score)
        .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
        .map((s) => ({ index: s.id, score: s.score }));
      // hits the reranker didn't score go last, in search order
      order = [...ranked, ...order.filter((o) => !seen.has(o.index))];
      reranked = true;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const top = order.slice(0, topK);
  const kept = top.map((o) => ({ ...hits[o.index]!, snippet: trimSnippet(hits[o.index]!.snippet, query) }));
  if (opts.citeSpanId) {
    for (const h of kept) ctx.emit({ type: "citation", spanId: opts.citeSpanId, source: { title: h.title, url: h.url, snippet: h.snippet } });
  }
  return {
    hits: kept,
    kept: kept.length,
    dropped: hits.length - kept.length,
    topScores: top.filter((o) => o.score !== undefined).map((o) => Math.round(o.score! * 1000) / 1000),
    reranked,
    ...(error ? { error } : {}),
  };
}
