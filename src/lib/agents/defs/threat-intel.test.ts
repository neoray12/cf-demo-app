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
  it("is registered and uses kimi-k2.6 everywhere", () => {
    expect(AGENTS["threat-intel"]).toBe(threatIntelAgent);
    expect(threatIntelAgent.defaultModel).toBe("kimi-k2.6");
    expect(threatIntelAgent.functionId).toBe("threat-intel-agent");
    for (const a of [attackAnalyst, networkAnalyst, botAnalyst]) {
      expect(a.model).toBe("kimi-k2.6");
      expect(a.maxSteps).toBe(4);
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
    expect(sub.calls[0]![1]).toEqual({ question: "q", location: "TW" });
  });

  it("normalises location and forwards domain", async () => {
    await run({ question: "q", analysts: ["bot"], location: "jp", domain: "example.com" });
    expect(sub.calls[0]![1]).toEqual({ question: "q", location: "JP", domain: "example.com" });
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
