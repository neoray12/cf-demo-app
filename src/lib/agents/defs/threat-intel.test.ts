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

import { attackAnalyst, botAnalyst, dispatchAnalysts, networkAnalyst, threatIntelAgent, type ThreatPrefetch } from "./threat-intel";
import type { TraceEvent } from "../trace-events";
import { AGENTS } from "../registry";

const ctx = { env: {}, signal: new AbortController().signal, emit: () => {} } as unknown as RunContext;
const plan = (analysts: Array<"attack" | "network" | "bot">, extra: Record<string, unknown> = {}) => ({
  analysts,
  location: "TW",
  compareLastWeek: false,
  ...extra,
});

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

  it("system prompts carry the scope rules; the root has no tools and no plan sentence", () => {
    const sys = threatIntelAgent.system(ctx);
    expect(sys).not.toContain("先用使用者提問的語言寫一句簡短的計畫");
    expect(sys).toContain("不要寫計畫句");
    expect(sys).toContain("【分析師報告】");
    expect(Object.keys(threatIntelAgent.tools(ctx))).toEqual([]);
    expect(threatIntelAgent.maxSteps).toBe(1);
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
  });

  it("analyst prompt includes question, location and domain", () => {
    expect(botAnalyst.prompt({ question: "q", location: "JP", domain: "a.com" })).toBe("問題：q\nlocation：JP\ndomain：a.com");
    expect(attackAnalyst.prompt({ question: "q", location: "TW" })).toBe("問題：q\nlocation：TW");
    expect(attackAnalyst.prompt({ question: "q", location: "TW", language: "zh-TW", prefetched: "已預先取得：x" })).toBe(
      "問題：q\nlocation：TW\n輸出語言：繁體中文\n\n已預先取得：x",
    );
    expect(attackAnalyst.prompt({ question: "q", location: "TW", compareLastWeek: true })).toContain("與上週比較：是");
  });

  it("analyst prepare waits for the parallel prefetch summary, but not forever", async () => {
    expect(await attackAnalyst.prepare!({ question: "q", location: "TW", pendingPrefetch: Promise.resolve("已預先取得：y") }, ctx, "s")).toBe(
      "已預先取得：y",
    );
    expect(await attackAnalyst.prepare!({ question: "q", location: "TW" }, ctx, "s")).toBe("");
    vi.useFakeTimers();
    try {
      const p = attackAnalyst.prepare!({ question: "q", location: "TW", pendingPrefetch: new Promise(() => {}) }, ctx, "s");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await p).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dispatchAnalysts (under the deterministic brief span)", () => {
  it("fans out the planned analysts under the given parent span, deduped", async () => {
    const out = await dispatchAnalysts(ctx, "root/brief", plan(["attack", "network", "attack"]), "q");
    expect(out.reports.map((r) => r.analyst)).toEqual(["attack", "network"]);
    expect(out.failed).toEqual([]);
    expect(sub.calls.map((c) => [c[0], c[3], c[4]])).toEqual([
      ["attack-analyst", "root/brief", 0],
      ["network-analyst", "root/brief", 1],
    ]);
    expect(sub.calls[0]![1]).toEqual({ question: "q", location: "TW", language: "en" });
  });

  it("forwards location, domain and compareLastWeek", async () => {
    await dispatchAnalysts(ctx, "root/brief", plan(["bot"], { location: "JP", domain: "example.com", compareLastWeek: true }), "q");
    expect(sub.calls[0]![1]).toEqual({ question: "q", location: "JP", domain: "example.com", compareLastWeek: true, language: "en" });
  });

  it("reports failed and empty analysts in `failed`", async () => {
    sub.texts["attack-analyst"] = new Error("boom");
    sub.texts["network-analyst"] = "   ";
    const out = await dispatchAnalysts(ctx, "root/brief", plan(["attack", "network", "bot"]), "q");
    expect(out.reports.map((r) => r.analyst)).toEqual(["bot"]);
    expect(out.failed.map((f) => f.name).sort()).toEqual(["attack", "network"]);
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
    expect(sys).toContain("failed");
    expect(threatIntelAgent.prefetchMode).toBe("await");
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

  it("prefetch: dispatch → Radar prefetch + brief in parallel; the context carries the reports", async () => {
    const { c, events, fetchMock } = prefetchCtx();
    sub.texts["attack-analyst"] = "attack finding https://radar.cloudflare.com/x";
    c.userText = "誰在攻擊日本？跟上週比有什麼變化？";
    const pre = await threatIntelAgent.prefetch!(c, "root", c.userText);
    expect(events[0]).toEqual({ type: "span-start", id: "root/dispatch", parentId: "root", kind: "execute_tool", name: "dispatch", t: 0 });
    expect(events.find((e) => e.type === "span-end" && e.id === "root/dispatch")).toMatchObject({
      status: "ok",
      detail: { output: { analysts: ["attack"], location: "JP", compareLastWeek: true } },
    });
    const starts = events.filter((e) => e.type === "span-start").map((e) => (e as { id: string }).id);
    expect(starts.slice(0, 3)).toEqual(["root/dispatch", "root/prefetch", "root/brief"]);
    expect(events.find((e) => e.type === "span-input" && e.id === "root/prefetch")).toEqual({
      type: "span-input",
      id: "root/prefetch",
      input: { location: "JP", compareLastWeek: true },
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(events.find((e) => e.type === "chart")).toMatchObject({ type: "chart", spanId: "root/prefetch" });
    expect(sub.calls.map((call) => [call[0], call[3]])).toEqual([["attack-analyst", "root/brief"]]);
    const input = sub.calls[0]![1] as { location: string; compareLastWeek: boolean; pendingPrefetch: Promise<string> };
    expect(input).toMatchObject({ location: "JP", compareLastWeek: true, language: "zh-TW" });
    expect(await input.pendingPrefetch).toContain('已預先取得：attackers_of({"location":"JP","compareLastWeek":true})');
    expect(events.at(-1)).toMatchObject({ type: "span-end", status: "ok" });
    const data = pre.data as ThreatPrefetch;
    expect(data.plan.tool).toBe("attackers_of");
    expect(data.reports).toEqual([{ analyst: "attack", report: "attack finding https://radar.cloudflare.com/x" }]);
    expect(pre.context).toContain("【分析師報告】");
    expect(pre.context).toContain("### attack-analyst\nattack finding");
    expect(pre.context).toContain("【預先查詢的 Radar 資料】");
    expect(pre.context).not.toContain("failed");
    fetchMock.mockRestore();
  });

  it("prefetch failure: the Radar span ends in error, analysts still run, failed analysts are listed", async () => {
    const { c, events, fetchMock } = prefetchCtx();
    fetchMock.mockResolvedValue(Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 500 }));
    sub.texts["attack-analyst"] = new Error("boom");
    const pre = await threatIntelAgent.prefetch!(c, "root", "誰在攻擊台灣");
    expect(events.find((e) => e.type === "span-end" && e.id === "root/prefetch")).toMatchObject({ status: "error" });
    expect(events.find((e) => e.type === "span-end" && e.id === "root/brief")).toMatchObject({ status: "error" });
    const input = sub.calls[0]![1] as { pendingPrefetch: Promise<string> };
    expect(await input.pendingPrefetch).toContain("失敗");
    expect(pre.context).toContain("【failed：沒有結果的分析師】attack（boom）");
    fetchMock.mockRestore();
  });
});

