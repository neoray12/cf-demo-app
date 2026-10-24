import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runtime";
import type { TraceEvent } from "../trace-events";
import type { DocsSearchHit } from "./cf-docs";
import { compressDocsHits, hasCjk, RERANK_MODEL, translateDocsQuery, trimSnippet, workersAiRerank, type Reranker } from "./docs-query";

describe("translateDocsQuery", () => {
  it("maps the Workers vs Pages question to product names + comparison keywords", () => {
    expect(translateDocsQuery("Workers 和 Pages 差在哪？新專案該選哪個？")).toEqual({
      query: "Workers vs Pages for a new project",
      products: ["Workers", "Pages"],
    });
  });

  it("maps Chinese terms to official product names", () => {
    expect(translateDocsQuery("物件儲存的價格是多少？")).toEqual({ query: "R2 pricing", products: ["R2"] });
    expect(translateDocsQuery("無伺服器函式怎麼連資料庫？")).toEqual({ query: "Workers D1 how to", products: ["Workers", "D1"] });
    expect(translateDocsQuery("鍵值儲存有什麼限制").products).toEqual(["Workers KV"]);
    expect(translateDocsQuery("有狀態的協作應用").products).toEqual(["Durable Objects"]);
    expect(translateDocsQuery("零信任和隧道如何設定").query).toBe("Zero Trust Cloudflare Tunnel how to configure");
    expect(translateDocsQuery("AI 閘道與推論模型").products).toEqual(["AI Gateway", "Workers AI"]);
    expect(translateDocsQuery("防火牆、DDoS 與機器人防護").products).toEqual(["WAF", "Bot Management", "DDoS Protection"]);
    expect(translateDocsQuery("憑證與網域設定").products).toEqual(["SSL/TLS", "DNS"]);
    expect(translateDocsQuery("佇列、向量、排程、快取").products).toEqual(["Queues", "Vectorize", "Cron Triggers", "Cache"]);
    expect(translateDocsQuery("影片和圖片").products).toEqual(["Stream", "Images"]);
    expect(translateDocsQuery("用瀏覽器爬蟲抓網頁，再寄郵件").products).toEqual(["Browser Rendering", "Email Routing"]);
    expect(translateDocsQuery("負載平衡的費用").query).toBe("Load Balancing pricing");
  });

  it("keeps Latin tokens (APIs, code) that the glossary doesn't cover, without duplicating products", () => {
    expect(translateDocsQuery("如何在 wrangler.toml 設定 KV binding？")).toEqual({
      query: "Workers KV how to configure wrangler.toml binding",
      products: ["Workers KV"],
    });
    expect(translateDocsQuery("Workers AI 的模型價格").query).toBe("Workers AI pricing");
  });

  it("a comparison without two products keeps the keyword; English 'vs' is not repeated", () => {
    expect(translateDocsQuery("R2 和 S3 的差異").query).toBe("R2 comparison S3");
    expect(translateDocsQuery("D1 vs KV 的限制比較").query).toBe("D1 vs Workers KV limits");
  });

  it("English text is returned unchanged (products still detected); unknown CJK falls back to the text", () => {
    expect(translateDocsQuery("  How do I bind R2 to a Worker?  ")).toEqual({ query: "How do I bind R2 to a Worker?", products: ["Workers", "R2"] });
    expect(translateDocsQuery("你好")).toEqual({ query: "你好", products: [] });
    expect(hasCjk("Workers 和 Pages")).toBe(true);
    expect(hasCjk("Workers vs Pages")).toBe(false);
  });
});

const ctx = (events: TraceEvent[] = []) =>
  ({ env: { CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" }, signal: new AbortController().signal, emit: (e: TraceEvent) => events.push(e) }) as unknown as RunContext;

const hit = (i: number, snippet = `snippet ${i}`): DocsSearchHit => ({ url: `https://developers.cloudflare.com/p${i}/`, title: `T${i}`, snippet });

describe("compressDocsHits", () => {
  afterEach(() => vi.restoreAllMocks());

  it("orders by reranker score, keeps topK, cites only the kept hits", async () => {
    const events: TraceEvent[] = [];
    const rerank: Reranker = vi.fn(async () => [
      { id: 0, score: 0.1 },
      { id: 3, score: 0.9 },
      { id: 1, score: 0.5 },
      { id: 4, score: 0.7 },
      { id: 2, score: 0.2 },
    ]);
    const out = await compressDocsHits(ctx(events), "workers pages", [0, 1, 2, 3, 4].map((i) => hit(i)), 3, { citeSpanId: "s/rerank", rerank });
    expect(out.hits.map((h) => h.title)).toEqual(["T3", "T4", "T1"]);
    expect(out).toMatchObject({ kept: 3, dropped: 2, topScores: [0.9, 0.7, 0.5], reranked: true });
    expect(rerank).toHaveBeenCalledWith(expect.anything(), "workers pages", ["T0\nsnippet 0", "T1\nsnippet 1", "T2\nsnippet 2", "T3\nsnippet 3", "T4\nsnippet 4"]);
    expect(events.map((e) => (e as { source: { title: string } }).source.title)).toEqual(["T3", "T4", "T1"]);
    expect(events.every((e) => e.type === "citation" && e.spanId === "s/rerank")).toBe(true);
  });

  it("honours topK; hits the reranker didn't score go last", async () => {
    const out = await compressDocsHits(ctx(), "q", [0, 1, 2, 3].map((i) => hit(i)), 2, { rerank: async () => [{ id: 2, score: 0.4 }] });
    expect(out.hits.map((h) => h.title)).toEqual(["T2", "T0"]);
    expect(out.dropped).toBe(2);
  });

  it("falls back to the first topK hits when the reranker fails", async () => {
    const out = await compressDocsHits(ctx(), "q", [0, 1, 2, 3, 4].map((i) => hit(i)), 3, {
      rerank: async () => {
        throw new Error("rerank failed (500)");
      },
    });
    expect(out.hits.map((h) => h.title)).toEqual(["T0", "T1", "T2"]);
    expect(out).toMatchObject({ kept: 3, dropped: 2, topScores: [], reranked: false, error: "rerank failed (500)" });
  });

  it("does not call the reranker for ≤ topK hits", async () => {
    const rerank = vi.fn<Reranker>();
    const out = await compressDocsHits(ctx(), "q", [hit(0), hit(1)], 3, { rerank });
    expect(rerank).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kept: 2, dropped: 0, reranked: false });
  });

  it("trims snippets to ≤ 700 chars, centred on the first query keyword", async () => {
    const long = `${"intro ".repeat(200)}Durable Objects pricing details ${"tail ".repeat(200)}`;
    const out = await compressDocsHits(ctx(), "Durable Objects pricing", [hit(0, long)], 3);
    const s = out.hits[0]!.snippet;
    expect(s.length).toBeLessThanOrEqual(700);
    expect(s).toContain("Durable Objects pricing details");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });

  it("trimSnippet: short text unchanged, no keyword → head, keyword near the end → tail window", () => {
    expect(trimSnippet("short", "x")).toBe("short");
    const text = "a".repeat(1000);
    expect(trimSnippet(text, "zzz")).toHaveLength(700);
    expect(trimSnippet(text, "zzz").endsWith("…")).toBe(true);
    const tail = `${"b".repeat(1000)} limits`;
    const t = trimSnippet(tail, "Workers limits");
    expect(t.length).toBeLessThanOrEqual(700);
    expect(t.endsWith(" limits")).toBe(true);
  });

  it("workersAiRerank posts {query, contexts} to the Workers AI REST endpoint and reads result.response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, result: { response: [{ id: 1, score: 0.8 }, { id: 0, score: 0.2 }] } }),
    );
    expect(await workersAiRerank(ctx(), "q", ["a", "b"])).toEqual([
      { id: 1, score: 0.8 },
      { id: 0, score: 0.2 },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/acc/ai/run/${RERANK_MODEL}`);
    expect(JSON.parse(String(init!.body))).toEqual({ query: "q", contexts: [{ text: "a" }, { text: "b" }] });
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    fetchMock.mockResolvedValue(Response.json({ success: false, errors: [{ message: "bad" }] }, { status: 400 }));
    await expect(workersAiRerank(ctx(), "q", ["a"])).rejects.toThrow("rerank failed (400): bad");
  });
});
