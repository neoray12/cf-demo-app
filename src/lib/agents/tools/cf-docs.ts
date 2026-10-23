// Cloudflare docs tools: search via the public cf-docs MCP server, read pages via
// Browser Rendering /markdown. Span start/end for tool calls come from the runtime's
// execute wrapper — tools only emit citations.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { callMcpTool, parseMcpServerUrls, type McpServerConfig } from "../../mcp-client";
import type { RunContext } from "../runtime";

const DOCS_HOST = "developers.cloudflare.com";
const SNIPPET_MAX = 600;
const SEARCH_LIMIT = 5;
const PAGE_MAX_CHARS = 12_000;
const SEARCH_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 30_000;

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

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (msg: string, name: string) => {
      const e = new Error(msg);
      e.name = name;
      reject(e);
    };
    if (signal.aborted) return fail("aborted", "AbortError");
    const timer = setTimeout(() => fail(`timed out after ${ms}ms`, "TimeoutError"), ms);
    const onAbort = () => fail("aborted", "AbortError");
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function buildDocsTools(ctx: RunContext, opts: { withRead: boolean }): ToolSet {
  const tools: ToolSet = {
    search_docs: tool({
      description:
        "Search the official Cloudflare documentation. Returns up to 5 hits with url, title and a snippet.",
      inputSchema: z.object({ query: z.string().min(1).describe("Search query (English works best)") }),
      execute: async ({ query }, options) => {
        const res = await withTimeout(
          callMcpTool(cfDocsServer(ctx), "search_cloudflare_documentation", { query }),
          SEARCH_TIMEOUT_MS,
          ctx.signal,
        );
        const text = res.content.map((c) => c.text ?? "").join("\n");
        if (res.isError) return { error: text.slice(0, 500) || "docs search failed", results: [] };
        const seen = new Set<string>();
        const results = parseDocsSearchResult(text)
          .filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)))
          .slice(0, SEARCH_LIMIT);
        for (const r of results) {
          ctx.emit({
            type: "citation",
            spanId: options.toolCallId,
            source: { title: r.title, url: r.url, snippet: r.snippet },
          });
        }
        return { results };
      },
    }),
  };

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
