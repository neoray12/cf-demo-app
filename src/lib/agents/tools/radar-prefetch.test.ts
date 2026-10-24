import { describe, expect, it } from "vitest";
import type { RadarResult } from "./radar";
import { planRadarPrefetch, prefetchLocation, prefetchSummary } from "./radar-prefetch";

describe("planRadarPrefetch", () => {
  it("attack keywords -> attackers_of; compareLastWeek only with a comparison word", () => {
    expect(planRadarPrefetch("誰在攻擊台灣？")).toEqual({ tool: "attackers_of", input: { location: "TW" } });
    expect(planRadarPrefetch("誰在攻擊台灣？跟上週比有什麼變化？")).toEqual({
      tool: "attackers_of",
      input: { location: "TW", compareLastWeek: true },
    });
    expect(planRadarPrefetch("Who is running DDoS against Japan compared with last week?").input).toEqual({
      location: "JP",
      compareLastWeek: true,
    });
    expect(planRadarPrefetch("WAF 擋下多少").tool).toBe("attackers_of");
    expect(planRadarPrefetch("駭客").tool).toBe("attackers_of");
  });
  it("bot keywords -> bot_vs_human", () => {
    expect(planRadarPrefetch("台灣的機器人流量多嗎")).toEqual({ tool: "bot_vs_human", input: { location: "TW" } });
    expect(planRadarPrefetch("AI crawler traffic in the US").tool).toBe("bot_vs_human");
    expect(planRadarPrefetch("爬蟲").tool).toBe("bot_vs_human");
  });
  it("outage / network keywords -> outages", () => {
    for (const q of ["最近有斷網嗎", "香港有中斷事件嗎", "recent outage in Korea", "BGP 劫持", "台灣網速如何", "網路品質"]) {
      expect(planRadarPrefetch(q).tool).toBe("outages");
    }
    expect(planRadarPrefetch("新加坡最近有斷網嗎").input).toEqual({ location: "SG", recentOnly: true });
  });
  it("anything else defaults to attackers_of / TW", () => {
    expect(planRadarPrefetch("你好")).toEqual({ tool: "attackers_of", input: { location: "TW" } });
  });
  it("maps country names; the earliest mention wins; no mention = TW", () => {
    expect(prefetchLocation("日本")).toBe("JP");
    expect(prefetchLocation("美國的攻擊")).toBe("US");
    expect(prefetchLocation("新加坡")).toBe("SG");
    expect(prefetchLocation("香港")).toBe("HK");
    expect(prefetchLocation("韓國")).toBe("KR");
    expect(prefetchLocation("中國")).toBe("CN");
    expect(prefetchLocation("誰在攻擊日本和台灣")).toBe("JP");
    expect(prefetchLocation("tell us about the weather")).toBe("TW");
    expect(prefetchLocation("")).toBe("TW");
  });
});

describe("prefetchSummary", () => {
  const plan = { tool: "attackers_of", input: { location: "TW", compareLastWeek: true } } as const;
  const result: RadarResult = {
    title: "攻擊台灣的來源國家",
    scope: "攻擊台灣的來源",
    unit: "percent",
    period: "過去 7 天",
    data: [
      { label: "中國", value: 40.123, previous: 38 },
      { label: "美國", value: 20 },
    ],
    sourceUrl: "https://radar.cloudflare.com/x",
  };
  it("states the call, the numbers and that it must not be repeated", () => {
    const text = prefetchSummary(plan, result);
    expect(text).toContain('已預先取得：attackers_of({"location":"TW","compareLastWeek":true})');
    expect(text).toContain("不要再呼叫");
    expect(text).toContain("中國 40.12（上週 38）；美國 20");
    expect(text).toContain("unit：percent");
    expect(text).toContain("sourceUrl：https://radar.cloudflare.com/x");
  });
  it("failure / missing result leaves the analysts free to query", () => {
    expect(prefetchSummary(plan, { error: "boom" })).toContain("失敗（boom）");
    expect(prefetchSummary(plan, undefined)).toContain("沒有結果");
  });
  it("empty data says no records", () => {
    expect(prefetchSummary(plan, { ...result, data: [] })).toContain("此期間無紀錄");
  });
  it("caps rows and events", () => {
    const many = { ...result, data: Array.from({ length: 30 }, (_, i) => ({ label: `L${i}`, value: i })) };
    const text = prefetchSummary(plan, many);
    expect(text).toContain("L9 9");
    expect(text).not.toContain("L10 ");
  });
});
