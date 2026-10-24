import * as aiNs from "ai";
import type { TextStreamPart, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runtime";
import type { TraceEvent } from "../trace-events";
import { docsAgent, docsResearcher } from "./docs";

type Part = TextStreamPart<ToolSet>;
const p = (o: Record<string, unknown>) => o as unknown as Part;

const hitsXml = (q: string) =>
  `<result><url>https://developers.cloudflare.com/${encodeURIComponent(q)}/</url><title>${q}</title><text>about ${q}</text></result>`;

function mcpResponse(query: string): Response {
  const body = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: hitsXml(query) }] } };
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function makeCtx() {
  const events: TraceEvent[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const ai = {
    ...aiNs,
    streamText: (args: Record<string, unknown>) => {
      calls.push(args);
      return {
        fullStream: (async function* () {
          yield p({ type: "start-step", request: {}, warnings: [] });
          yield p({ type: "text-delta", id: "t", text: `- summary of ${String(args.prompt).split("\n")[0]}` });
          yield p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" });
        })(),
      };
    },
  } as unknown as typeof import("ai");
  const ctx = {
    env: { MCP_SERVER_URLS: "cf-docs=https://docs.mcp.cloudflare.com/mcp", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t", AI_GATEWAY_ID: "g" },
    ai,
    emit: (e: TraceEvent) => events.push(e),
    now: () => 0,
    conversationId: "c",
    storeContent: false,
    signal: new AbortController().signal,
    modelKey: "kimi-k2.6-thinking",
  } as unknown as RunContext;
  return { ctx, events, calls };
}

const exec = (t: unknown, input: unknown, toolCallId = "root/call-1") =>
  (t as { execute(i: unknown, o: unknown): Promise<unknown> }).execute(input, { toolCallId, messages: [] });

describe("docs agent (lean flow)", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_u, init) => mcpResponse(JSON.parse(init!.body as string).params.arguments.query));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("root: research / overview / read_doc_page (no search_docs), 3 steps, background prefetch", () => {
    const { ctx } = makeCtx();
    expect(Object.keys(docsAgent.tools(ctx)).sort()).toEqual(["overview", "read_doc_page", "research"]);
    expect(docsAgent.maxSteps).toBe(3);
    expect(docsAgent.prefetchMode ?? "background").toBe("background");
    expect(docsResearcher.maxSteps).toBe(1);
    expect(docsResearcher.tools(ctx)).toEqual({});
  });

  it("prefetch: search_docs(user question) as span `{root}/prefetch` with citations", async () => {
    const { ctx, events } = makeCtx();
    const pre = await docsAgent.prefetch!(ctx, "root", "Workers 和 Pages 差在哪？");
    expect(events[0]).toEqual({ type: "span-start", id: "root/prefetch", parentId: "root", kind: "execute_tool", name: "search_docs", t: 0 });
    expect(events.filter((e) => e.type === "citation").map((e) => (e as { spanId: string }).spanId)).toEqual(["root/prefetch"]);
    expect(pre.data).toEqual({ results: [expect.objectContaining({ title: "Workers 和 Pages 差在哪？" })] });
  });

  it("overview() returns the prefetched results (awaiting them)", async () => {
    const { ctx } = makeCtx();
    let release!: (v: unknown) => void;
    ctx.prefetched = new Promise((r) => (release = r)) as never;
    const pending = exec(docsAgent.tools(ctx).overview, {});
    release({ data: { results: [{ url: "u", title: "t", snippet: "s" }] } });
    expect(await pending).toEqual({ results: [{ url: "u", title: "t", snippet: "s" }] });
    ctx.prefetched = Promise.resolve({});
    expect(await exec(docsAgent.tools(ctx).overview, {})).toEqual({ results: [], error: "overview search failed" });
  });

  it("research: researchers in parallel, each = one traced search inside its own span + one no-think model call", async () => {
    const { ctx, events, calls } = makeCtx();
    ctx.prefetched = Promise.resolve({ data: { results: [{ url: "u", title: "overview", snippet: "s" }] } });
    ctx.userText = "Workers 和 Pages 差在哪？";
    const out = (await exec(docsAgent.tools(ctx).research, { questions: ["What is Workers?", "What is Pages?"] })) as {
      findings: Array<{ question: string; summary: string }>;
      failed: unknown[];
      overview: unknown;
    };
    expect(out.failed).toEqual([]);
    expect(out.findings.map((f) => f.question)).toEqual(["What is Workers?", "What is Pages?"]);
    expect(out.overview).toEqual({ results: [{ url: "u", title: "overview", snippet: "s" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [i, q] of ["What is Workers?", "What is Pages?"].entries()) {
      const sub = `root/call-1:docs-researcher:${i}`;
      const starts = events.filter((e) => e.type === "span-start" && (e.id === sub || e.id.startsWith(`${sub}/`) || e.id.startsWith(`${sub}:`)));
      expect(starts.map((e) => [(e as { id: string }).id, (e as { kind: string }).kind])).toEqual([
        [sub, "invoke_agent"],
        [`${sub}/search`, "execute_tool"],
        [`${sub}:chat:0`, "chat"],
      ]);
      expect(events.find((e) => e.type === "citation" && e.spanId === `${sub}/search`)).toBeTruthy();
      expect(events.find((e) => e.type === "span-end" && e.id === `${sub}/search`)).toMatchObject({ status: "ok" });
      const call = calls.find((c) => String(c.prompt).startsWith(`Sub-question: ${q}`))!;
      expect(call.prompt).toContain("Documentation search results:");
      // researchers write in the user's language (the question is Chinese; the sub-questions are English)
      expect(call.prompt).toContain("繁體中文");
      expect(call.prompt).toContain(`URL: https://developers.cloudflare.com/${encodeURIComponent(q)}/`);
      // the menu's thinking model applies to the root only
      expect((call.experimental_telemetry as { metadata: { model: string } }).metadata.model).toBe("kimi-k2.6");
    }
  });

  it("researcher prompt carries the user's language; the root prompt forbids pasting untranslated paragraphs", () => {
    expect(docsResearcher.prompt({ question: "q", language: "en" })).toBe("Sub-question: q\nWrite your output in English.");
    expect(docsResearcher.prompt({ question: "q", language: "zh-TW" })).toContain("繁體中文");
    expect(docsResearcher.prompt({ question: "q" })).toBe("Sub-question: q");
    expect(docsResearcher.system).not.toContain("in English");
    const { ctx } = makeCtx();
    const sys = docsAgent.system(ctx);
    expect(sys).toContain("絕對不要貼上未翻譯的英文段落");
    expect(sys).toContain("網址保持原樣");
  });

  it("an English question gets English researcher findings", async () => {
    const { ctx, calls } = makeCtx();
    ctx.userText = "What is the difference between Workers and Pages?";
    ctx.prefetched = Promise.resolve({ data: { results: [] } });
    await exec(docsAgent.tools(ctx).research, { questions: ["What is Workers?", "What is Pages?"] });
    expect(String(calls[0]!.prompt)).toContain("Write your output in English.");
  });
});
