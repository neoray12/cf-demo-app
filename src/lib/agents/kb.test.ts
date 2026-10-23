import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./runtime";

const sub = vi.hoisted(() => ({ calls: [] as unknown[][], text: "" as string }));
vi.mock("./runtime", async (orig) => ({
  ...(await orig<typeof import("./runtime")>()),
  runSubagent: vi.fn(async (def: { functionId: string }, ...rest: unknown[]) => {
    sub.calls.push([def.functionId, ...rest]);
    return { text: sub.text };
  }),
}));

import { isValidWorkspace, kbFileStatuses, kbSearch, kbSearchBody, newWorkspaceId, safeUploadName, slugFromUrl, hostSlugFromUrl, countUploadedDocs, validateUpload } from "./kb";
import { buildKbTools } from "./tools/kb";
import { groundingChecker, kbAgent } from "./defs/knowledge-base";
import { AGENTS } from "./registry";

const MB = 1024 * 1024;

describe("isValidWorkspace / newWorkspaceId", () => {
  it.each(["default", "ws-a1b2c3d4"])("accepts %s", (id) => expect(isValidWorkspace(id)).toBe(true));
  it.each(["ws-../x", "WS-A1B2C3D4", "ws-a1b2c3d", "ws-a1b2c3d45", "", "default/", "other"])("rejects %s", (id) =>
    expect(isValidWorkspace(id)).toBe(false),
  );
  it("newWorkspaceId produces a valid, varying id", () => {
    const a = newWorkspaceId();
    expect(isValidWorkspace(a)).toBe(true);
    expect(a).not.toBe(newWorkspaceId());
  });
});

describe("validateUpload", () => {
  it("rejects files over 10 MB", () => expect(validateUpload({ name: "a.pdf", size: 11 * MB }, 0)).toBe("agents.kb.errors.tooLarge"));
  it("rejects unsupported types", () => expect(validateUpload({ name: "a.exe", size: 10 }, 0)).toBe("agents.kb.errors.badType"));
  it("rejects when the workspace already holds 20 files", () =>
    expect(validateUpload({ name: "a.md", size: 10 }, 20)).toBe("agents.kb.errors.tooMany"));
  it.each(["a.pdf", "a.docx", "a.md", "a.txt", "A.PDF"])("accepts %s at 5 MB", (name) =>
    expect(validateUpload({ name, size: 5 * MB }, 0)).toBeNull(),
  );
});

describe("kbSearchBody", () => {
  it("filters on the workspace folder with the new AI Search filter format", () => {
    expect(kbSearchBody("ws-a1b2c3d4", "q", 5)).toEqual({
      messages: [{ role: "user", content: "q" }],
      ai_search_options: {
        query_rewrite: { enabled: false },
        retrieval: { max_num_results: 5, filters: { folder: { $gte: "ws-a1b2c3d4/", $lt: "ws-a1b2c3d40" } } },
      },
    });
  });
});

describe("kbSearch", () => {
  const env = { CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok", KB_AI_SEARCH: "inst" } as never;
  beforeEach(() => vi.restoreAllMocks());

  it("posts to the namespaced instance, drops score < 0.3 and truncates snippets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        result: {
          chunks: [
            { score: 0.8, text: "x".repeat(4000), item: { key: "default/a.md" } },
            { score: 0.2, text: "low", item: { key: "default/b.md" } },
          ],
        },
      }),
    );
    const out = await kbSearch(env, "default", "q", 5);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/ai-search/namespaces/default/instances/inst/search",
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ filename: "default/a.md", score: 0.8, sourceUrl: null });
    expect(out.results[0]!.snippet).toHaveLength(3000);
    expect(out.topScore).toBe(0.8);
  });

  it("rejects an invalid workspace without calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(kbSearch(env, "../x", "q")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("safeUploadName / slugFromUrl", () => {
  it("keeps ASCII and CJK, replaces the rest, drops directories", () => {
    expect(safeUploadName("C:\\x\\出差 規定(v2).PDF")).toBe("出差_規定_v2_.PDF");
    expect(safeUploadName("../../etc/pass wd.md")).toBe("pass_wd.md");
    expect(safeUploadName(".hidden.md")).toBe("hidden.md");
  });
  it("rejects names with an empty stem", () => {
    for (const n of ["???.md", "", "_.txt", "///"]) expect(safeUploadName(n)).toBeNull();
  });
  it("caps the length and keeps the extension", () => {
    const out = safeUploadName(`${"a".repeat(300)}.md`)!;
    expect(out.length).toBe(100);
    expect(out.endsWith(".md")).toBe(true);
  });
  it("slugs URL paths", () => {
    expect(slugFromUrl("https://example.com/")).toBe("index");
    expect(slugFromUrl("https://example.com/Docs/Get_Started/?x=1")).toBe("docs-get-started");
    expect(slugFromUrl(`https://example.com/${"a".repeat(200)}`)).toHaveLength(80);
    expect(slugFromUrl("not a url")).toBe("index");
  });
  it("slugs hostnames (dots become dashes)", () => {
    expect(hostSlugFromUrl("https://Example.com/a")).toBe("example-com");
    expect(hostSlugFromUrl("https://docs.my-site.co.uk:8080/")).toBe("docs-my-site-co-uk");
    expect(hostSlugFromUrl("https://127.0.0.1/")).toBe("127-0-0-1");
    expect(hostSlugFromUrl("not a url")).toBe("site");
  });
});

describe("countUploadedDocs", () => {
  it("counts only top-level uploads, ignoring everything under site/", () => {
    const docs = [
      { key: "ws-a1b2c3d4/a.md" },
      { key: "ws-a1b2c3d4/b.pdf" },
      { key: "ws-a1b2c3d4/site/example-com/index.md" },
      { key: "ws-a1b2c3d4/site/example-com/about.md" },
      { key: "ws-a1b2c3d4/sitemap.md" },
    ];
    expect(countUploadedDocs("ws-a1b2c3d4", docs)).toBe(3);
    expect(countUploadedDocs("ws-a1b2c3d4", [])).toBe(0);
  });
});

describe("kbFileStatuses", () => {
  const env = { CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok", KB_AI_SEARCH: "inst" } as never;
  beforeEach(() => vi.restoreAllMocks());

  it("filters to the workspace prefix, passes status through and surfaces errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        result: [
          { key: "ws-a1b2c3d4/a.md", status: "running", error: null },
          { key: "ws-a1b2c3d4/b.md", status: "error", error: "boom" },
          { key: "default/c.md", status: "completed", error: null },
          { key: "ws-a1b2c3d45/d.md", status: "completed", error: null },
        ],
      }),
    );
    const out = await kbFileStatuses(env, "ws-a1b2c3d4");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/ai-search/instances/inst/items?per_page=50&page=1",
    );
    expect(out).toEqual([
      { key: "ws-a1b2c3d4/a.md", status: "running" },
      { key: "ws-a1b2c3d4/b.md", status: "error", error: "boom" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches at most two pages", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ key: `default/${i}.md`, status: "completed" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: true, result: full }));
    await kbFileStatuses(env, "default");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid workspace without calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(kbFileStatuses(env, "../x")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const ctxBase = { env: {}, workspace: "default", signal: new AbortController().signal } as unknown as RunContext;
const exec = (tools: ReturnType<typeof buildKbTools>, input: unknown, id = "root/tc-1") =>
  (tools.search_kb as unknown as { execute(i: unknown, o: unknown): Promise<unknown> }).execute(input, { toolCallId: id, messages: [] });

describe("search_kb", () => {
  it("returns an explicit not-found instruction when the search is empty", async () => {
    const emit = vi.fn();
    const tools = buildKbTools({ ...ctxBase, emit } as RunContext, async () => ({ results: [], topScore: 0 }));
    expect(await exec(tools, { query: "公司股價" })).toEqual({
      results: [],
      instruction: "知識庫中沒有相關資料。請明確回覆找不到，不要用一般知識作答。",
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits one citation per result keyed by the namespaced toolCallId, and numbers the results", async () => {
    const emit = vi.fn();
    const search = vi.fn(async () => ({
      results: [
        { filename: "default/travel-expense.md", score: 0.9, snippet: "住宿上限", sourceUrl: null },
        { filename: "default/employee-handbook.md", score: 0.5, snippet: "特休", sourceUrl: null },
      ],
      topScore: 0.9,
    }));
    const tools = buildKbTools({ ...ctxBase, emit } as RunContext, search);
    const out = (await exec(tools, { query: "住宿", maxResults: 3 })) as { results: Array<{ n: number; filename: string }> };
    expect(search).toHaveBeenCalledWith(ctxBase.env, "default", "住宿", 3, ctxBase.signal);
    expect(out.results.map((r) => [r.n, r.filename])).toEqual([
      [1, "default/travel-expense.md"],
      [2, "default/employee-handbook.md"],
    ]);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: "citation",
      spanId: "root/tc-1",
      source: { title: "default/travel-expense.md", snippet: "住宿上限", score: 0.9 },
    });
  });

  it("returns an error object (not a throw) when the workspace is invalid", async () => {
    const tools = buildKbTools({ ...ctxBase, workspace: "../x", emit: vi.fn() } as RunContext, async () => ({ results: [], topScore: 0 }));
    expect(await exec(tools, { query: "q" })).toMatchObject({ results: [], error: expect.any(String) });
  });
});

describe("knowledge-base agent", () => {
  beforeEach(() => {
    sub.calls = [];
    sub.text = "";
  });

  it("is registered, uses kimi-k2.6 everywhere", () => {
    expect(AGENTS["knowledge-base"]).toBe(kbAgent);
    expect(kbAgent.id).toBe("knowledge-base");
    expect(kbAgent.functionId).toBe("kb-agent");
    expect(kbAgent.defaultModel).toBe("kimi-k2.6");
    expect(kbAgent.maxSteps).toBe(4);
    expect(groundingChecker.functionId).toBe("grounding-checker");
    expect(groundingChecker.model).toBe("kimi-k2.6");
    expect(groundingChecker.maxSteps).toBe(1);
    expect(groundingChecker.tools(ctxBase)).toEqual({});
  });

  it("groundingChecker tells the checker to ignore planning/meta sentences", () => {
    expect(groundingChecker.system).toContain("計畫");
    expect(groundingChecker.system).toContain("我先查詢");
  });

  it("groundingChecker.toDetail parses JSON and flags parse errors", () => {
    expect(groundingChecker.toDetail!('```json\n{"unsupported":["A"]}\n```')).toEqual({ unsupported: ["A"] });
    expect(groundingChecker.toDetail!("not json")).toEqual({ unsupported: [], parseError: true });
    expect(groundingChecker.toDetail!('{"unsupported":"x"}')).toEqual({ unsupported: [], parseError: true });
  });

  it("after() runs the grounding checker with numbered sources only when search_kb returned results", async () => {
    const ctx = { ...ctxBase, emit: vi.fn() } as RunContext;
    await kbAgent.after!(ctx, {
      text: "上限 3,200 元 [1]",
      rootSpanId: "root",
      toolResults: [
        { toolName: "search_kb", output: { results: [{ n: 1, filename: "default/travel-expense.md", snippet: "台北 3,200 元" }] } },
        { toolName: "search_kb", output: { results: [{ n: 2, filename: "default/it-support-faq.md", snippet: "WARP" }] } },
      ],
    });
    expect(sub.calls).toHaveLength(1);
    const [id, input, , parent, index] = sub.calls[0]! as [string, { answer: string; sources: string }, unknown, string, number];
    expect(id).toBe("grounding-checker");
    expect(input.answer).toBe("上限 3,200 元 [1]");
    expect(input.sources).toContain("[1] default/travel-expense.md");
    expect(input.sources).toContain("台北 3,200 元");
    expect(input.sources).toContain("[2] default/it-support-faq.md");
    expect([parent, index]).toEqual(["root", 0]);
  });

  it("after() skips the checker when nothing was found or search_kb was never called", async () => {
    const ctx = { ...ctxBase, emit: vi.fn() } as RunContext;
    await kbAgent.after!(ctx, { text: "找不到", rootSpanId: "root", toolResults: [{ toolName: "search_kb", output: { results: [], instruction: "x" } }] });
    await kbAgent.after!(ctx, { text: "hi", rootSpanId: "root", toolResults: [] });
    expect(sub.calls).toHaveLength(0);
  });
});
