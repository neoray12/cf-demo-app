// Cloudflare docs tools: search via the public cf-docs MCP server, read pages via
// Browser Rendering /markdown. Span start/end for tool calls come from the runtime's
// execute wrapper — tools only emit citations.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parseMcpServerUrls, type McpServerConfig } from "../../mcp-client";
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

// ---------------------------------------------------------------------------
// One cf-docs MCP connection per run.
//
// Opening a connection (initialize handshake) costs 1-3 s, and parallel researchers each issue several
// searches, so the connection is created lazily on first use and shared through `ctx.scope` (a run-scoped
// registry that runAgent disposes in its `finally` => closed on success, error and abort alike; subagents
// get a spread copy of the RunContext, so the scope is the one object they all share — a WeakMap keyed by
// RunContext would not be). On a connection error the call retries once on a fresh connection.
// mcp-client.ts is deliberately left untouched; this mirrors its connect logic (Streamable HTTP, SSE fallback).

const DOCS_CLIENT_KEY = Symbol("cf-docs-mcp-client");

interface ClientHolder {
  current?: Promise<Client>;
  /** Set by the scope's dispose. A holder disposed before use (scope.once after the run ended) is not reused. */
  disposed?: boolean;
}

async function connectDocsClient(server: McpServerConfig): Promise<Client> {
  const make = () => new Client({ name: "cf-demo-agent", version: "1.0.0" }, { capabilities: {} });
  const options = { timeout: SEARCH_TIMEOUT_MS };
  const http = make();
  try {
    await http.connect(new StreamableHTTPClientTransport(new URL(server.url)), options);
    return http;
  } catch {
    await http.close().catch(() => {});
  }
  const sse = make();
  try {
    await sse.connect(new SSEClientTransport(new URL(server.url)), options);
    return sse;
  } catch (err) {
    await sse.close().catch(() => {});
    throw err;
  }
}

function closeLater(p: Promise<Client> | undefined): void {
  void p?.then((c) => c.close()).catch(() => {});
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** Wait for `p`, but reject as soon as `signal` aborts (the connect itself keeps going and is closed later). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Connection-level failures are worth one retry; JSON-RPC errors (incl. our own timeout) are not. */
function isRetryable(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed;
  return true;
}

export async function searchDocs(ctx: RunContext, query: string): Promise<{ text: string; isError: boolean }> {
  const server = cfDocsServer(ctx);
  // An aborted run must not take (or re-create, after the scope was disposed) the shared holder, nor connect.
  if (ctx.signal.aborted) throw abortError();
  const scoped = ctx.scope?.once<ClientHolder>(DOCS_CLIENT_KEY, () => ({}), (h) => {
    h.disposed = true;
    closeLater(h.current);
  });

  for (let attempt = 0; ; attempt++) {
    // A disposed holder (scope.once after the run ended, or disposeAll while this call was retrying) is not
    // reused: the call then owns its connection and closes it itself, like without a scope.
    const holder = scoped && !scoped.disposed ? scoped : undefined;
    const connecting = holder ? (holder.current ??= connectDocsClient(server)) : connectDocsClient(server);
    const evict = () => {
      if (holder && holder.current === connecting) holder.current = undefined;
      closeLater(connecting);
    };
    let client: Client;
    try {
      client = await abortable(connecting, ctx.signal);
    } catch (err) {
      if (!ctx.signal.aborted) evict();
      else if (!holder) closeLater(connecting);
      if (attempt >= 1 || !isRetryable(err, ctx.signal)) throw err;
      continue;
    }
    try {
      const res = (await client.callTool(
        { name: "search_cloudflare_documentation", arguments: { query } },
        undefined,
        { signal: ctx.signal, timeout: SEARCH_TIMEOUT_MS },
      )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      if (!holder) closeLater(connecting);
      return { text: (res.content ?? []).map((c) => c.text ?? "").join("\n"), isError: res.isError === true };
    } catch (err) {
      if (attempt >= 1 || !isRetryable(err, ctx.signal)) {
        if (!holder) closeLater(connecting);
        throw err;
      }
      evict();
    }
  }
}

export function buildDocsTools(ctx: RunContext, opts: { withRead: boolean }): ToolSet {
  const tools: ToolSet = {
    search_docs: tool({
      description:
        "Search the official Cloudflare documentation. Returns up to 5 hits with url, title and a snippet.",
      inputSchema: z.object({ query: z.string().min(1).describe("Search query (English works best)") }),
      execute: async ({ query }, options) => {
        const { text, isError } = await searchDocs(ctx, query);
        if (isError) return { error: text.slice(0, 500) || "docs search failed", results: [] };
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
