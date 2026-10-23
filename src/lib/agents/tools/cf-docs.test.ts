import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runtime";
import { isAllowedDocUrl, parseDocsSearchResult, searchDocs } from "./cf-docs";

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
// shared MCP connection (SDK mocked)

const sdk = vi.hoisted(() => {
  const state = {
    connects: 0,
    closes: 0,
    failNextCall: 0,
    calls: [] as Array<{ query: string; signal?: AbortSignal; timeout?: number }>,
  };
  class FakeClient {
    async connect() {
      state.connects++;
      await new Promise((r) => setTimeout(r, 5));
    }
    async callTool(params: { arguments: { query: string } }, _schema: unknown, options?: { signal?: AbortSignal; timeout?: number }) {
      state.calls.push({ query: params.arguments.query, signal: options?.signal, timeout: options?.timeout });
      if (state.failNextCall > 0) {
        state.failNextCall--;
        throw new Error("fetch failed");
      }
      return { content: [{ type: "text", text: "<result><url>https://developers.cloudflare.com/a/</url><title>A</title><text>t</text></result>" }] };
    }
    async close() {
      state.closes++;
    }
  }
  return { state, FakeClient };
});
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: sdk.FakeClient }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class {} }));

describe("searchDocs shared connection", () => {
  const makeCtx = (withScope: boolean): { ctx: RunContext; dispose(): Promise<void> } => {
    const entries: Array<() => void | Promise<void>> = [];
    const store = new Map<unknown, unknown>();
    const ctx = {
      env: { MCP_SERVER_URLS: "cf-docs=https://docs.mcp.cloudflare.com/mcp" },
      emit: () => {},
      signal: new AbortController().signal,
      scope: withScope
        ? {
            once<T>(key: unknown, create: () => T, dispose: (v: T) => void | Promise<void>): T {
              if (!store.has(key)) {
                const v = create();
                store.set(key, v);
                entries.push(() => dispose(v));
              }
              return store.get(key) as T;
            },
          }
        : undefined,
    } as unknown as RunContext;
    return { ctx, dispose: async () => void (await Promise.all(entries.map((f) => f()))) };
  };

  beforeEach(() => {
    sdk.state.connects = 0;
    sdk.state.closes = 0;
    sdk.state.failNextCall = 0;
    sdk.state.calls = [];
  });

  it("opens one connection for parallel searches and closes it when the run scope is disposed", async () => {
    const { ctx, dispose } = makeCtx(true);
    const rs = await Promise.all(["a", "b", "c", "d"].map((q) => searchDocs(ctx, q)));
    expect(rs.every((r) => !r.isError && r.text.includes("<result>"))).toBe(true);
    expect(sdk.state.connects).toBe(1);
    expect(sdk.state.closes).toBe(0);
    // truly abortable + timeoutable calls tied to the run signal
    expect(sdk.state.calls.every((c) => c.signal === ctx.signal && c.timeout === 20_000)).toBe(true);
    await dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(sdk.state.closes).toBe(1);
  });

  it("retries once on a fresh connection after a connection error", async () => {
    const { ctx, dispose } = makeCtx(true);
    sdk.state.failNextCall = 1;
    const r = await searchDocs(ctx, "x");
    expect(r.isError).toBe(false);
    expect(sdk.state.connects).toBe(2);
    expect(sdk.state.calls).toHaveLength(2);
    await dispose();
    await new Promise((r2) => setTimeout(r2, 5));
    expect(sdk.state.closes).toBe(2); // the evicted one and the replacement
  });

  it("gives up after the single retry", async () => {
    const { ctx } = makeCtx(true);
    sdk.state.failNextCall = 2;
    await expect(searchDocs(ctx, "x")).rejects.toThrow("fetch failed");
    expect(sdk.state.calls).toHaveLength(2);
  });

  it("without a run scope the connection is closed after the call", async () => {
    const { ctx } = makeCtx(false);
    await searchDocs(ctx, "x");
    await new Promise((r) => setTimeout(r, 5));
    expect(sdk.state.connects).toBe(1);
    expect(sdk.state.closes).toBe(1);
  });

  it("does not call the server when the signal is already aborted", async () => {
    const { ctx } = makeCtx(true);
    const ac = new AbortController();
    ac.abort();
    await expect(searchDocs({ ...ctx, signal: ac.signal }, "x")).rejects.toThrow("aborted");
    expect(sdk.state.calls).toHaveLength(0);
  });

  it("a pre-aborted search opens no connection and does not touch the run scope", async () => {
    let onceCalls = 0;
    const base = makeCtx(true).ctx;
    const scope = base.scope!;
    const ac = new AbortController();
    ac.abort();
    const ctx = {
      ...base,
      signal: ac.signal,
      scope: { once: (...args: Parameters<typeof scope.once>) => (onceCalls++, scope.once(...args)) },
    } as RunContext;
    await expect(searchDocs(ctx, "x")).rejects.toThrow("aborted");
    await new Promise((r) => setTimeout(r, 10));
    expect(sdk.state.connects).toBe(0);
    expect(onceCalls).toBe(0);
    // and the same without a run scope
    await expect(searchDocs({ ...ctx, scope: undefined }, "x")).rejects.toThrow("aborted");
    await new Promise((r) => setTimeout(r, 10));
    expect(sdk.state.connects).toBe(0);
  });

  it("a holder disposed before its first connect closes that connection after use instead of leaking it", async () => {
    // simulates scope.once() after disposeAll: the dispose callback runs immediately on the fresh holder
    const ctx = {
      env: { MCP_SERVER_URLS: "cf-docs=https://docs.mcp.cloudflare.com/mcp" },
      emit: () => {},
      signal: new AbortController().signal,
      scope: {
        once<T>(_key: unknown, create: () => T, dispose: (v: T) => void | Promise<void>): T {
          const v = create();
          void dispose(v);
          return v;
        },
      },
    } as unknown as RunContext;
    const r = await searchDocs(ctx, "x");
    expect(r.isError).toBe(false);
    await new Promise((r2) => setTimeout(r2, 10));
    expect(sdk.state.connects).toBe(1);
    expect(sdk.state.closes).toBe(1);
  });
});
