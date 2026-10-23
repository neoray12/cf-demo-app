import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runtime";
import {
  DOCS_CACHE_TTL_S,
  SEARCH_TIMEOUT_MS,
  docsCacheKey,
  isAllowedDocUrl,
  parseDocsSearchResult,
  searchDocs,
  searchDocsHits,
  searchDocsWithCitations,
} from "./cf-docs";

const fixture = readFileSync(join(__dirname, "__fixtures__", "cf-docs-search.txt"), "utf8");

describe("parseDocsSearchResult", () => {
  it("parses <result> blocks from the cf-docs MCP search output", () => {
    const results = parseDocsSearchResult(fixture);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.url.startsWith("https://developers.cloudflare.com/")).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.snippet.length).toBeLessThanOrEqual(600);
    }
  });

  it("returns [] for text without result blocks", () => {
    expect(parseDocsSearchResult("no results")).toEqual([]);
  });
});

describe("isAllowedDocUrl", () => {
  it("allows developers.cloudflare.com over https", () => {
    expect(isAllowedDocUrl("https://developers.cloudflare.com/workers/")).toBe(true);
  });
  it.each([
    "http://developers.cloudflare.com/",
    "https://developers.cloudflare.com.evil.com/",
    "https://evil.com/?u=https://developers.cloudflare.com/",
    "javascript:alert(1)",
    "https://user@evil.com/",
    "not a url",
  ])("rejects %s", (u) => {
    expect(isAllowedDocUrl(u)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// independent searches (fetch stubbed; SDK client mocked for the 4xx fallback)

const sdk = vi.hoisted(() => {
  const state = { connects: 0, closes: 0, calls: 0 };
  class FakeClient {
    async connect() {
      state.connects++;
    }
    async callTool() {
      state.calls++;
      return {
        content: [
          { type: "text", text: "<result><url>https://developers.cloudflare.com/sdk/</url><title>SDK</title><text>s</text></result>" },
        ],
      };
    }
    async close() {
      state.closes++;
    }
  }
  return { state, FakeClient };
});
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: sdk.FakeClient }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));

const RESULT_TEXT =
  "<result><url>https://developers.cloudflare.com/a/</url><title>A</title><text>t</text></result>" +
  "<result><url>https://developers.cloudflare.com/a/</url><title>A dup</title><text>t</text></result>" +
  "<result><url>https://developers.cloudflare.com/b/</url><title>B</title><text>u</text></result>";

function rpc(text: string, isError = false) {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } };
}

/** An SSE body split into small chunks (events cross chunk boundaries). */
function sseResponse(body: unknown, split = 7): Response {
  const payload = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  const bytes = new TextEncoder().encode(payload);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface FakeKV {
  store: Map<string, string>;
  puts: Array<{ key: string; ttl?: number }>;
  failGet?: boolean;
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

function fakeKV(): FakeKV {
  const kv: FakeKV = {
    store: new Map(),
    puts: [],
    async get(key) {
      if (kv.failGet) throw new Error("kv down");
      const v = kv.store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key, value, opts) {
      kv.store.set(key, value);
      kv.puts.push({ key, ttl: opts?.expirationTtl });
    },
  };
  return kv;
}

function makeCtx(kv?: FakeKV, signal = new AbortController().signal) {
  const events: unknown[] = [];
  const ctx = {
    env: { MCP_SERVER_URLS: "cf-docs=https://docs.mcp.cloudflare.com/mcp", KV: kv },
    emit: (e: unknown) => events.push(e),
    signal,
  } as unknown as RunContext;
  return { ctx, events };
}

describe("searchDocs: one independent request per search", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    sdk.state.connects = 0;
    sdk.state.closes = 0;
    sdk.state.calls = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parallel searches are separate stateless tools/call POSTs (no session), each tied to the run signal", async () => {
    fetchMock.mockImplementation(async () => sseResponse(rpc(RESULT_TEXT)));
    const run = new AbortController();
    const { ctx } = makeCtx(undefined, run.signal);
    const rs = await Promise.all(["a", "b", "c", "d"].map((q) => searchDocs(ctx, q)));
    expect(rs.every((r) => !r.isError && r.text.includes("<result>"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const queries = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "search_cloudflare_documentation" } });
      expect(new Headers(init!.headers).get("mcp-session-id")).toBeNull();
      return body.params.arguments.query;
    });
    expect(queries).toEqual(["a", "b", "c", "d"]);
    // each request's signal follows the run signal
    const sig = fetchMock.mock.calls[0]![1]!.signal!;
    expect(sig.aborted).toBe(false);
    run.abort();
    expect(sig.aborted).toBe(true);
    expect(sdk.state.connects).toBe(0);
  });

  it("parses a plain JSON response too", async () => {
    fetchMock.mockResolvedValue(Response.json(rpc(RESULT_TEXT)));
    const r = await searchDocs(makeCtx().ctx, "x");
    expect(r).toEqual({ text: RESULT_TEXT, isError: false });
  });

  it("falls back to a short-lived MCP client of its own when the stateless call is rejected (4xx), and closes it", async () => {
    fetchMock.mockResolvedValue(new Response("session required", { status: 400 }));
    const r = await searchDocs(makeCtx().ctx, "x");
    expect(r.text).toContain("/sdk/");
    await new Promise((res) => setTimeout(res, 0));
    expect(sdk.state).toEqual({ connects: 1, calls: 1, closes: 1 });
  });

  it.each([401, 403, 429, 500, 503])("a %i is not a stateless rejection: no client fallback", async (status) => {
    fetchMock.mockResolvedValue(new Response("nope", { status }));
    await expect(searchDocs(makeCtx().ctx, "x")).rejects.toThrow(/docs search failed/);
    expect(sdk.state.connects).toBe(0);
  });

  it.each([404, 405, 406])("a %i falls back to the MCP client", async (status) => {
    fetchMock.mockResolvedValue(new Response("no", { status }));
    expect((await searchDocs(makeCtx().ctx, "x")).text).toContain("/sdk/");
    expect(sdk.state.connects).toBe(1);
  });

  it("retries a network error once, then gives up", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(sseResponse(rpc(RESULT_TEXT)));
    expect((await searchDocs(makeCtx().ctx, "x")).isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(searchDocs(makeCtx().ctx, "x")).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a JSON-RPC error", async () => {
    fetchMock.mockResolvedValue(Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }));
    await expect(searchDocs(makeCtx().ctx, "x")).rejects.toThrow("bad params");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it(`times out after ${SEARCH_TIMEOUT_MS / 1000} s with a clear message`, async () => {
    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    fetchMock.mockImplementation(
      (_u, init) =>
        new Promise((_, reject) =>
          init!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        ),
    );
    const p = searchDocs(makeCtx().ctx, "x");
    await Promise.resolve();
    timeout.abort();
    await expect(p).rejects.toThrow(`docs search timed out after ${SEARCH_TIMEOUT_MS / 1000} s`);
    expect(spy).toHaveBeenCalledWith(25_000);
  });

  it("does not call the server when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(searchDocs(makeCtx(undefined, ac.signal).ctx, "x")).rejects.toThrow("aborted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("docs search KV cache", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const attrs: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    fetchMock.mockReset();
    attrs.length = 0;
    vi.stubGlobal("fetch", fetchMock);
    globalThis.__CF_WORKERS__ = {
      tracing: { getActiveSpan: () => ({ setAttribute: (k: string, v: unknown) => void attrs.push({ [k]: v }) }) },
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete globalThis.__CF_WORKERS__;
  });

  it("normalizes the query into the key and hashes keys longer than KV allows", async () => {
    expect(await docsCacheKey("  Workers   VS Pages ")).toBe("docs-search:v1:workers vs pages");
    expect(await docsCacheKey("字".repeat(400))).toMatch(/^docs-search:v1:sha256:[0-9a-f]{64}$/);
  });

  it("miss → live search, deduped hits written with a 1 h TTL; hit → no request, cache.hit attribute", async () => {
    const kv = fakeKV();
    fetchMock.mockImplementation(async () => sseResponse(rpc(RESULT_TEXT)));
    const first = await searchDocsHits(makeCtx(kv).ctx, "Workers vs Pages");
    expect(first.cacheHit).toBe(false);
    expect(first.hits.map((h) => h.url)).toEqual(["https://developers.cloudflare.com/a/", "https://developers.cloudflare.com/b/"]);
    expect(kv.puts).toEqual([{ key: "docs-search:v1:workers vs pages", ttl: DOCS_CACHE_TTL_S }]);
    expect(DOCS_CACHE_TTL_S).toBe(3600);
    expect(attrs).toContainEqual({ "cache.hit": false });

    const second = await searchDocsHits(makeCtx(kv).ctx, "workers  vs pages");
    expect(second).toEqual({ hits: first.hits, cacheHit: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attrs).toContainEqual({ "cache.hit": true });
  });

  it("the KV write is fire-and-forget: a hanging or rejecting put neither delays nor fails the search", async () => {
    fetchMock.mockImplementation(async () => sseResponse(rpc(RESULT_TEXT)));
    const kv = fakeKV();
    kv.put = () => new Promise<void>(() => {}); // never resolves
    expect((await searchDocsHits(makeCtx(kv).ctx, "hang")).hits).toHaveLength(2);
    kv.put = () => Promise.reject(new Error("kv write failed"));
    expect((await searchDocsHits(makeCtx(kv).ctx, "reject")).hits).toHaveLength(2);
  });

  it("a KV failure falls through to a live call; tool errors are returned and not cached", async () => {
    const kv = fakeKV();
    kv.failGet = true;
    fetchMock.mockImplementation(async () => sseResponse(rpc(RESULT_TEXT)));
    expect((await searchDocsHits(makeCtx(kv).ctx, "q")).hits).toHaveLength(2);

    const kv2 = fakeKV();
    fetchMock.mockImplementation(async () => sseResponse(rpc("upstream exploded", true)));
    expect(await searchDocsHits(makeCtx(kv2).ctx, "q")).toEqual({ hits: [], cacheHit: false, error: "upstream exploded" });
    expect(kv2.puts).toEqual([]);
  });

  it("searchDocsWithCitations emits one citation per returned hit under the given span", async () => {
    fetchMock.mockImplementation(async () => sseResponse(rpc(RESULT_TEXT)));
    const { ctx, events } = makeCtx();
    const r = await searchDocsWithCitations(ctx, "q", "run/prefetch", 1);
    expect(r.results).toHaveLength(1);
    expect(events).toEqual([
      { type: "citation", spanId: "run/prefetch", source: { title: "A", url: "https://developers.cloudflare.com/a/", snippet: "t" } },
    ]);
  });
});
