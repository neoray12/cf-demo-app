import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runtime";

const sub = vi.hoisted(() => ({ calls: [] as unknown[][], texts: {} as Record<string, string | Error> }));
vi.mock("../runtime", async (orig) => ({
  ...(await orig<typeof import("../runtime")>()),
  runSubagent: vi.fn(async (def: { functionId: string }, ...rest: unknown[]) => {
    sub.calls.push([def.functionId, ...rest]);
    const r = sub.texts[def.functionId] ?? "report";
    if (r instanceof Error) throw r;
    return { text: r };
  }),
}));

import { attackAnalyst, botAnalyst, networkAnalyst, threatIntelAgent } from "./threat-intel";
import type { TraceEvent } from "../trace-events";
import { AGENTS } from "../registry";

const ctx = { env: {}, signal: new AbortController().signal, emit: () => {} } as unknown as RunContext;
const brief = () =>
  (threatIntelAgent.tools(ctx).brief as unknown as { execute(i: unknown, o: unknown): Promise<unknown> });
const run = (input: unknown) => brief().execute(input, { toolCallId: "root/tc-1", messages: [] });

beforeEach(() => {
  sub.calls = [];
  sub.texts = {};
});

describe("threat-intel agent definition", () => {
  it("is registered and uses glm-5.3-flash everywhere", () => {
    expect(AGENTS["threat-intel"]).toBe(threatIntelAgent);
    expect(threatIntelAgent.defaultModel).toBe("glm-5.3-flash");
    expect(threatIntelAgent.functionId).toBe("threat-intel-agent");
    for (const a of [attackAnalyst, networkAnalyst, botAnalyst]) {
      expect(a.model).toBe("glm-5.3-flash");
      expect(a.maxSteps).toBe(3);
    }
  });

  it("each analyst only gets its own tools", () => {
    expect(Object.keys(attackAnalyst.tools(ctx))).toEqual([
      "attackers_of",
      "attack_targets_from",
      "l7_attacks_from",
      "l3_attacks_mitigated_in",
      "top_attacked_industries",
      "l7_attack_trend_from",
    ]);
    expect(Object.keys(networkAnalyst.tools(ctx))).toEqual(["outages", "traffic_anomalies", "bgp_hijacks", "internet_quality"]);
    expect(Object.keys(botAnalyst.tools(ctx))).toEqual(["bot_vs_human", "ai_crawlers", "email_threats", "domain_rank"]);
  });

  it("system prompts carry the scope rules and the plan-first sentence", () => {
    const sys = threatIntelAgent.system(ctx);
    expect(sys).toContain("先用使用者提問的語言寫一句簡短的計畫");
    expect(sys).toContain("brief");
    expect(sys).toContain("不是台灣被攻擊");
    expect(sys).toContain("金融業");
    expect(attackAnalyst.system).toContain("不可改寫");
    expect(attackAnalyst.system).toContain("此期間無紀錄");
    for (const sys of [attackAnalyst.system, networkAnalyst.system, botAnalyst.system, threatIntelAgent.system(ctx)]) {
      expect(sys).not.toContain("所有數字都是占比");
      expect(sys).toContain("mbps / ms");
      expect(sys).toContain("rank");
    }
    expect(networkAnalyst.system).toContain("compareLastWeek: true");
    const desc = (threatIntelAgent.tools(ctx).brief as unknown as { description: string }).description;
    expect(desc).toContain("先用一句話告訴使用者你要派哪些分析師");
  });

  it("analyst prompt includes question, location and domain", () => {
    expect(botAnalyst.prompt({ question: "q", location: "JP", domain: "a.com" })).toBe("問題：q\nlocation：JP\ndomain：a.com");
    expect(attackAnalyst.prompt({ question: "q", location: "TW" })).toBe("問題：q\nlocation：TW");
    expect(attackAnalyst.prompt({ question: "q", location: "TW", language: "zh-TW", prefetched: "已預先取得：x" })).toBe(
      "問題：q\nlocation：TW\n輸出語言：繁體中文\n\n已預先取得：x",
    );
  });
});

describe("brief tool", () => {
  it("fans out the chosen analysts with the namespaced toolCallId and dedupes", async () => {
    const out = (await run({ question: "q", analysts: ["attack", "network", "attack"] })) as {
      reports: Array<{ analyst: string; report: string }>;
      failed: unknown[];
    };
    expect(out.reports.map((r) => r.analyst)).toEqual(["attack", "network"]);
    expect(out.failed).toEqual([]);
    expect(sub.calls.map((c) => [c[0], c[3], c[4]])).toEqual([
      ["attack-analyst", "root/tc-1", 0],
      ["network-analyst", "root/tc-1", 1],
    ]);
    expect(sub.calls[0]![1]).toEqual({ question: "q", location: "TW", language: "en" });
  });

  it("normalises location and forwards domain", async () => {
    await run({ question: "q", analysts: ["bot"], location: "jp", domain: "example.com" });
    expect(sub.calls[0]![1]).toEqual({ question: "q", location: "JP", domain: "example.com", language: "en" });
  });

  it("reports failed and empty analysts in `failed`", async () => {
    sub.texts["attack-analyst"] = new Error("boom");
    sub.texts["network-analyst"] = "   ";
    const out = (await run({ question: "q", analysts: ["attack", "network", "bot"] })) as {
      reports: Array<{ analyst: string }>;
      failed: Array<{ name: string; error: string }>;
    };
    expect(out.reports.map((r) => r.analyst)).toEqual(["bot"]);
    expect(out.failed.map((f) => f.name).sort()).toEqual(["attack", "network"]);
  });

  it("an invalid location returns {error} without dispatching", async () => {
    const out = await run({ question: "q", analysts: ["attack"], location: "Japan" });
    expect(out).toMatchObject({ error: expect.stringContaining("ISO 3166-1") });
    expect(sub.calls).toEqual([]);
  });
});

describe("threat-intel speed-ups", () => {
  it("analysts: ONE parallel tool round, a short finding, in the user's language; root answer is concise", () => {
    for (const a of [attackAnalyst, networkAnalyst, botAnalyst]) {
      expect(a.system).toContain("並行呼叫你需要的「所有」工具");
      expect(a.system).toContain("不超過 150 個中文字");
      expect(a.system).toContain("不要用相同參數再呼叫同一個工具");
      expect(a.system).toContain("輸出語言");
    }
    const sys = threatIntelAgent.system(ctx);
    expect(sys).toContain("不超過 350 個中文字");
    expect(sys).toContain("最多一個精簡表格");
    expect(sys).toContain("不要貼上未翻譯的段落");
    expect(sys).toContain("不是台灣被攻擊"); // scope honesty stays
    expect(threatIntelAgent.prefetchMode).toBe("background");
  });

  const radarJson = JSON.parse(
    readFileSync(join(__dirname, "..", "tools", "__fixtures__", "radar", "attackers_of.json"), "utf8"),
  ) as unknown;

  function prefetchCtx() {
    const events: TraceEvent[] = [];
    const kv = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(radarJson));
    const c = {
      env: { CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a", KV: kv },
      emit: (e: TraceEvent) => events.push(e),
      now: () => 0,
      storeContent: false,
      conversationId: "c",
      signal: new AbortController().signal,
    } as unknown as RunContext;
    return { c, events, fetchMock };
  }

  it("prefetch: one Radar tool as span `{root}/prefetch` with its chart under that span id", async () => {
    const { c, events, fetchMock } = prefetchCtx();
    const pre = await threatIntelAgent.prefetch!(c, "root", "誰在攻擊日本？跟上週比有什麼變化？");
    expect(events[0]).toEqual({ type: "span-start", id: "root/prefetch", parentId: "root", kind: "execute_tool", name: "attackers_of", t: 0 });
    expect(events[1]).toEqual({ type: "span-input", id: "root/prefetch", input: { location: "JP", compareLastWeek: true } });
    expect(fetchMock).toHaveBeenCalled();
    const chart = events.find((e) => e.type === "chart");
    expect(chart).toMatchObject({ type: "chart", spanId: "root/prefetch" });
    expect(events.at(-1)).toMatchObject({ type: "span-end", id: "root/prefetch", status: "ok" });
    expect((pre.data as { plan: { tool: string } }).plan.tool).toBe("attackers_of");
    fetchMock.mockRestore();
  });

  it("prefetch failure: the span ends in error, the run goes on, and brief tells analysts to query themselves", async () => {
    const { c, events, fetchMock } = prefetchCtx();
    fetchMock.mockResolvedValue(Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 500 }));
    const pre = await threatIntelAgent.prefetch!(c, "root", "誰在攻擊台灣");
    expect(events.at(-1)).toMatchObject({ type: "span-end", id: "root/prefetch", status: "error" });
    c.prefetched = Promise.resolve(pre);
    await run2(c, { question: "q", analysts: ["attack"] });
    expect(String((sub.calls[0]![1] as { prefetched: string }).prefetched)).toContain("失敗");
    fetchMock.mockRestore();
  });

  it("brief awaits the prefetch and hands a compact summary to every analyst, plus the user's language", async () => {
    const { c, fetchMock } = prefetchCtx();
    c.userText = "誰在攻擊台灣？跟上週比有什麼變化？";
    const pre = await threatIntelAgent.prefetch!(c, "root", c.userText);
    let release!: (v: typeof pre) => void;
    c.prefetched = new Promise((r) => (release = r));
    const pending = run2(c, { question: "q", analysts: ["attack", "network"] });
    await Promise.resolve();
    expect(sub.calls).toEqual([]); // still waiting for the prefetch
    release(pre);
    await pending;
    expect(sub.calls).toHaveLength(2);
    for (const call of sub.calls) {
      const input = call[1] as { prefetched: string; language: string };
      expect(input.language).toBe("zh-TW");
      expect(input.prefetched).toContain('已預先取得：attackers_of({"location":"TW","compareLastWeek":true})');
      expect(input.prefetched).toMatch(/data：.*[\u4e00-\u9fff]+ \d/);
      expect(input.prefetched).toContain("不要再呼叫");
    }
    fetchMock.mockRestore();
  });
});

const run2 = (c: RunContext, input: unknown) =>
  (threatIntelAgent.tools(c).brief as unknown as { execute(i: unknown, o: unknown): Promise<unknown> }).execute(input, {
    toolCallId: "root/tc-1",
    messages: [],
  });
