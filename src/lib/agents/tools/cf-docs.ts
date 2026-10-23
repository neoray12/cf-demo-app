// Cloudflare docs tools: search via the public cf-docs MCP server, read pages via
// Browser Rendering /markdown. Span start/end for model tool calls come from the runtime's
// execute wrapper (deterministic searches use runTracedTool) — tools only emit citations.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseMcpServerUrls, type McpServerConfig } from "../../mcp-client";
import type { RunContext } from "../runtime";
import { setActiveSpanAttributes } from "../tracing";

const DOCS_HOST = "developers.cloudflare.com";
const SNIPPET_MAX = 600;
export const SEARCH_LIMIT = 5;
const PAGE_MAX_CHARS = 12_000;
/** Per search call (connect + call), tied to ctx.signal. The server takes 4.5–11 s per search. */
export const SEARCH_TIMEOUT_MS = 25_000;
const READ_TIMEOUT_MS = 30_000;
export const DOCS_CACHE_TTL_S = 3600;
export const DOCS_CACHE_PREFIX = "docs-search:v1:";
const KV_KEY_MAX_BYTES = 512;

export interface DocsSearchHit {
  url: string;
  title: string;
  snippet: string;
}

/** Parse the `<result><url/><title/><text/></result>` blocks returned by cf-docs `search_cloudflare_documentation`. */
export function parseDocsSearchResult(text: string): DocsSearchHit[] {
  const hits: DocsSearchHit[] = [];
  const blockRe = /<result>([\s\S]*?)<\/result>/g;
  const field = (block: string, tag: string) =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1]?.trim() ?? "";
  for (const m of text.matchAll(blockRe)) {
    const block = m[1] ?? "";
    const url = field(block, "url");
    const title = field(block, "title");
    if (!url || !title) continue;
    hits.push({ url, title, snippet: field(block, "text").slice(0, SNIPPET_MAX) });
  }
  return hits;
}

/** Only https://developers.cloudflare.com/... (no credentials, default port) may be fetched. */
export function isAllowedDocUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname === DOCS_HOST && u.port === "" && u.username === "" && u.password === "";
}

function cfDocsServer(ctx: RunContext): McpServerConfig {
  const server = parseMcpServerUrls(ctx.env.MCP_SERVER_URLS).find((s) => s.id === "cf-docs");
  if (!server) throw new Error("cf-docs MCP server is not configured");
  return server;
}

// ---------------------------------------------------------------------------
// One independent request per search.
//
// R15 (one shared MCP session per run) is reversed: the docs server handles concurrent independent requests in
// parallel (8 at once each took 4.5–11 s), but calls multiplexed on one session queued behind each other and the
// later ones hit the timeout. Each search is therefore a single stateless JSON-RPC `tools/call` POST (no
// initialize handshake, no session); if the server ever refuses that (4xx), the call falls back to its own
// short-lived MCP client (connect → call → close). Nothing is shared between calls, so there is nothing to dispose.

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

class StatelessRejected extends Error {}
/** A JSON-RPC error from the server: an answer, not a connection problem, so it is not retried. */
class RpcError extends Error {}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function toResult(res: ToolCallResult): { text: string; isError: boolean } {
  return { text: (res.content ?? []).map((c) => c.text ?? "").join("\n"), isError: res.isError === true };
}

/** Pick the JSON-RPC response with `id` out of a message (or batch); undefined when it isn't there. */
function pickResponse(msg: unknown, id: number): { result?: ToolCallResult; error?: { message?: string } } | undefined {
  const list = Array.isArray(msg) ? msg : [msg];
  for (const m of list) {
    if (m && typeof m === "object" && (m as { id?: unknown }).id === id) return m as never;
  }
  return undefined;
}

/** Read an SSE body until the response with `id` arrives (then stop reading). */
async function readSseResponse(body: ReadableStream<Uint8Array>, id: number) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      // events are separated by a blank line; `data:` lines of one event are joined with \n
      let sep: number;
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const hit = pickResponse(parsed, id);
        if (hit) return hit;
      }
      if (done) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  throw new Error("docs search: stream ended without a response");
}

async function statelessCall(url: string, query: string, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
  const id = 1;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "search_cloudflare_documentation", arguments: { query } },
    }),
    signal,
  });
  if (res.status >= 400 && res.status < 500) {
    void res.body?.cancel().catch(() => {});
    throw new StatelessRejected(`stateless call rejected (${res.status})`);
  }
  if (!res.ok || !res.body) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`docs search failed (HTTP ${res.status})`);
  }
  const type = res.headers.get("content-type") ?? "";
  const msg = type.includes("text/event-stream") ? await readSseResponse(res.body, id) : pickResponse(await res.json(), id);
  if (!msg) throw new Error("docs search: no JSON-RPC response");
  if (msg.error) throw new RpcError(`docs search error: ${msg.error.message ?? "unknown"}`);
  return toResult(msg.result ?? {});
}

/** Fallback: a short-lived MCP client of its own (never shared), closed after the call. */
async function clientCall(url: string, query: string, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: "cf-demo-agent", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), { signal, timeout: SEARCH_TIMEOUT_MS });
    const res = (await client.callTool(
      { name: "search_cloudflare_documentation", arguments: { query } },
      undefined,
      { signal, timeout: SEARCH_TIMEOUT_MS },
    )) as ToolCallResult;
    return toResult(res);
  } finally {
    void client.close().catch(() => {});
  }
}

/**
 * One docs search on its own request, aborted by ctx.signal and timed out after SEARCH_TIMEOUT_MS. A
 * connection-level failure (network error, 5xx) is retried once within the same time budget.
 */
export async function searchDocs(ctx: RunContext, query: string): Promise<{ text: string; isError: boolean }> {
  const server = cfDocsServer(ctx);
  if (ctx.signal.aborted) throw abortError();
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  for (let attempt = 0; ; attempt++) {
    try {
      try {
        return await statelessCall(server.url, query, signal);
      } catch (err) {
        if (!(err instanceof StatelessRejected)) throw err;
        return await clientCall(server.url, query, signal);
      }
    } catch (err) {
      if (ctx.signal.aborted) throw abortError();
      if (timeout.aborted) throw new Error(`docs search timed out after ${SEARCH_TIMEOUT_MS / 1000} s`);
      if (attempt >= 1 || err instanceof RpcError) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// KV cache (best effort)

export function normalizeDocsQuery(query: string): string {
  return query.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** `docs-search:v1:{normalized query}`; queries too long for a KV key (512 bytes) use a SHA-256 of it instead. */
export async function docsCacheKey(query: string): Promise<string> {
  const normalized = normalizeDocsQuery(query);
  const key = `${DOCS_CACHE_PREFIX}${normalized}`;
  if (new TextEncoder().encode(key).length <= KV_KEY_MAX_BYTES) return key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${DOCS_CACHE_PREFIX}sha256:${hex}`;
}

/**
 * Deduplicated hits for `query`: from KV when cached (TTL 1 h), otherwise one live search whose non-empty result
 * is written back. KV failures fall through to the live call. Sets the active span's `cache.hit`.
 * A server-side tool error comes back as `error` (not cached); timeouts / network errors throw.
 */
export async function searchDocsHits(
  ctx: RunContext,
  query: string,
): Promise<{ hits: DocsSearchHit[]; cacheHit: boolean; error?: string }> {
  let key: string | undefined;
  try {
    key = await docsCacheKey(query);
    const cached = (await ctx.env.KV?.get(key, "json")) as DocsSearchHit[] | null | undefined;
    if (Array.isArray(cached) && cached.length > 0) {
      setActiveSpanAttributes({ "cache.hit": true });
      return { hits: cached, cacheHit: true };
    }
  } catch {
    // a cache failure must never fail the search
  }
  setActiveSpanAttributes({ "cache.hit": false });
  const { text, isError } = await searchDocs(ctx, query);
  if (isError) return { hits: [], cacheHit: false, error: text.slice(0, 500) || "docs search failed" };
  const seen = new Set<string>();
  const hits = parseDocsSearchResult(text).filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)));
  if (key && hits.length > 0) {
    try {
      await ctx.env.KV?.put(key, JSON.stringify(hits), { expirationTtl: DOCS_CACHE_TTL_S });
    } catch {
      // best effort
    }
  }
  return { hits, cacheHit: false };
}

/**
 * Search + citations: the top `limit` hits are emitted as citations of span `spanId` (a tool span) and returned.
 * Shared by the model-callable `search_docs` tool, the run's prefetch and the researchers' deterministic search.
 */
export async function searchDocsWithCitations(
  ctx: RunContext,
  query: string,
  spanId: string,
  limit = SEARCH_LIMIT,
): Promise<{ results: DocsSearchHit[]; error?: string; cacheHit: boolean }> {
  const { hits, cacheHit, error } = await searchDocsHits(ctx, query);
  if (error) return { results: [], error, cacheHit };
  const results = hits.slice(0, limit);
  for (const r of results) {
    ctx.emit({ type: "citation", spanId, source: { title: r.title, url: r.url, snippet: r.snippet } });
  }
  return { results, cacheHit };
}

/** Search results as prompt text: numbered title, URL and snippet per hit. */
export function formatDocsHits(hits: DocsSearchHit[]): string {
  return hits.map((h, i) => `[${i + 1}] ${h.title}\nURL: ${h.url}\n${h.snippet}`).join("\n\n");
}

export function buildDocsTools(ctx: RunContext, opts: { withRead: boolean; withSearch?: boolean }): ToolSet {
  const tools: ToolSet = {};
  if (opts.withSearch !== false) {
    tools.search_docs = tool({
      description:
        "Search the official Cloudflare documentation. Returns up to 5 hits with url, title and a snippet.",
      inputSchema: z.object({ query: z.string().min(1).describe("Search query (English works best)") }),
      execute: async ({ query }, options) => {
        const { results, error } = await searchDocsWithCitations(ctx, query, options.toolCallId);
        return error ? { error, results: [] } : { results };
      },
    });
  }

  if (opts.withRead) {
    tools.read_doc_page = tool({
      description:
        "Read a Cloudflare documentation page as Markdown. Only https://developers.cloudflare.com/ URLs are allowed.",
      inputSchema: z.object({ url: z.string().describe("Full https://developers.cloudflare.com/... page URL") }),
      execute: async ({ url }) => {
        if (!isAllowedDocUrl(url)) return { error: "URL not allowed: only https://developers.cloudflare.com/ pages can be read" };
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${ctx.env.CF_ACCOUNT_ID}/browser-rendering/markdown`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${ctx.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
            signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
          },
        );
        const data = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> } | null;
        if (!res.ok || !data?.success || typeof data.result !== "string") {
          return { error: `read failed (${res.status}): ${data?.errors?.[0]?.message ?? "unexpected response"}` };
        }
        return { url, markdown: data.result.slice(0, PAGE_MAX_CHARS) };
      },
    });
  }

  return tools;
}
