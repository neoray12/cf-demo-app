import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runtime";
import type { TraceEvent } from "../trace-events";
import {
  RADAR_TOOL_NAMES,
  buildRadarRequest,
  buildRadarTools,
  normalizeLocation,
  parseRadar,
  radarQuery,
  type RadarToolName,
} from "./radar";

const setAttrs = vi.hoisted(() => vi.fn());
vi.mock("../tracing", () => ({ setActiveSpanAttributes: setAttrs }));

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", "radar", `${name}.json`), "utf8"));
const TW = { location: "TW" };

describe("normalizeLocation", () => {
  it("uppercases a 2-letter code and defaults to TW", () => {
    expect(normalizeLocation("jp")).toBe("JP");
    expect(normalizeLocation(undefined)).toBe("TW");
    expect(normalizeLocation("")).toBe("TW");
  });
  it.each(["Japan", "TWN", "t", "T1", "../x"])("rejects %s", (v) => {
    expect(() => normalizeLocation(v)).toThrow("location 必須是 ISO 3166-1 alpha-2 代碼，例如 TW、JP、US");
  });
});

describe("buildRadarRequest", () => {
  it("top_attacked_industries never sends location", () => {
    const { path, params } = buildRadarRequest("top_attacked_industries", { location: "TW" });
    expect(path).toBe("attacks/layer7/top/industry");
    expect(params.has("location")).toBe(false);
    expect(params.get("dateRange")).toBe("7d");
  });

  it("no tool ever sends an industry param, even when the model passes one", () => {
    for (const name of RADAR_TOOL_NAMES) {
      const { params } = buildRadarRequest(name, { location: "TW", industry: "Banking", domain: "cloudflare.com" });
      expect(params.has("industry")).toBe(false);
    }
  });

  it("compareLastWeek adds dateRange=7dControl", () => {
    const { params } = buildRadarRequest("attackers_of", { location: "TW", compareLastWeek: true });
    expect(params.getAll("dateRange")).toEqual(["7d", "7dControl"]);
    expect(buildRadarRequest("attackers_of", TW).params.getAll("dateRange")).toEqual(["7d"]);
  });

  it("maps each endpoint", () => {
    expect(buildRadarRequest("attackers_of", TW).path).toBe("attacks/layer7/top/locations/origin");
    expect(buildRadarRequest("attack_targets_from", TW).path).toBe("attacks/layer7/top/locations/target");
    expect(buildRadarRequest("l7_attacks_from", { ...TW, dimension: "http_method" }).path).toBe(
      "attacks/layer7/summary/http_method",
    );
    expect(buildRadarRequest("l7_attacks_from", TW).path).toBe("attacks/layer7/summary/mitigation_product");
    expect(buildRadarRequest("l3_attacks_mitigated_in", TW).path).toBe("attacks/layer3/summary/vector");
    expect(buildRadarRequest("l7_attack_trend_from", TW).params.get("aggInterval")).toBe("1d");
    expect(buildRadarRequest("traffic_anomalies", TW).params.get("dateRange")).toBe("28d");
    const bgp = buildRadarRequest("bgp_hijacks", { location: "jp" });
    expect(bgp.path).toBe("bgp/hijacks/events");
    expect(bgp.params.get("involvedCountry")).toBe("JP");
    expect(bgp.params.get("per_page")).toBe("10");
    expect(buildRadarRequest("internet_quality", TW).path).toBe("quality/speed/summary");
    expect(buildRadarRequest("bot_vs_human", TW).path).toBe("http/summary/bot_class");
    expect(buildRadarRequest("ai_crawlers", TW).path).toBe("ai/bots/summary/user_agent");
    expect(buildRadarRequest("email_threats", TW).params.has("location")).toBe(false);
  });

  it("outages: dateRange only with recentOnly (old events need no dateRange)", () => {
    expect(buildRadarRequest("outages", TW).params.has("dateRange")).toBe(false);
    expect(buildRadarRequest("outages", { ...TW, recentOnly: true }).params.get("dateRange")).toBe("52w");
  });

  it("rejects an unknown dimension and a bad location", () => {
    expect(() => buildRadarRequest("l7_attacks_from", { ...TW, dimension: "industry" })).toThrow();
    expect(() => buildRadarRequest("attackers_of", { location: "Japan" })).toThrow();
  });

  it("domain_rank: path carries the domain; rejects URLs and spaces", () => {
    expect(buildRadarRequest("domain_rank", { domain: "Cloudflare.com" }).path).toBe("ranking/domain/cloudflare.com");
    expect(() => buildRadarRequest("domain_rank", { domain: "https://x.com" })).toThrow();
    expect(() => buildRadarRequest("domain_rank", { domain: "a b.com" })).toThrow();
    expect(() => buildRadarRequest("domain_rank", {})).toThrow();
  });
});

describe("parseRadar", () => {
  it("attackers_of with comparison", () => {
    const r = parseRadar("attackers_of", fixture("attackers_of"), { ...TW, compareLastWeek: true });
    expect(r.unit).toBe("percent");
    expect(r.scope).toContain("攻擊台灣的來源國家");
    expect(r.scope).not.toContain("源自");
    expect(r.period).toBe("2026-10-16 ~ 2026-10-23");
    expect(r.data[0]).toEqual({ label: "美國", value: 22.605155, previous: 22.985498 });
    expect(r.data[1]).toMatchObject({ label: "中國", value: 5.821922, previous: 7.770979 });
    expect(r.sourceUrl).toBe("https://radar.cloudflare.com/security/application-layer/tw");
    expect(r.note).toContain("2026-10-09 ~ 2026-10-16");
  });

  it("attackers_of without comparison has no previous", () => {
    const r = parseRadar("attackers_of", fixture("attackers_of"), TW);
    expect(r.data[0]).toEqual({ label: "美國", value: 22.605155 });
  });

  it("attack_targets_from says the location is the ATTACKER side", () => {
    const r = parseRadar("attack_targets_from", fixture("attack_targets_from"), TW);
    expect(r.scope).toBe("源自台灣的攻擊目標國家（應用層）");
    expect(r.data[0]).toEqual({ label: "美國", value: 52.443532 });
  });

  it("l7_attacks_from is 'originating from', never 'on Taiwan'", () => {
    const r = parseRadar("l7_attacks_from", fixture("l7_attacks_from"), { ...TW, compareLastWeek: true });
    expect(r.scope).toBe("源自台灣的應用層攻擊，依緩解產品分布");
    expect(r.data[0]).toEqual({ label: "WAF", value: 88.383387, previous: 63.156337 });
    expect(r.data.find((d) => d.label === "DDOS")).toMatchObject({ value: 8.605242, previous: 32.082776 });
  });

  it("l3_attacks_mitigated_in", () => {
    const r = parseRadar("l3_attacks_mitigated_in", fixture("l3_attacks_mitigated_in"), { ...TW, compareLastWeek: true });
    expect(r.scope).toBe("在台灣資料中心緩解的網路層攻擊手法");
    expect(r.data[0]).toMatchObject({ label: "GRE Flood", value: 87.241274 });
    expect(r.data[0]!.previous).toBeUndefined(); // GRE Flood is absent from last week's list
    expect(r.data.find((d) => d.label === "SYN Flood")).toMatchObject({ previous: 7.023284 });
    expect(r.sourceUrl).toBe("https://radar.cloudflare.com/security/network-layer/tw");
  });

  it("top_attacked_industries is global", () => {
    const r = parseRadar("top_attacked_industries", fixture("top_attacked_industries"), TW);
    expect(r.scope).toBe("全球最常被攻擊的產業（應用層）");
    expect(r.data[0]).toEqual({ label: "Computer Software", value: 18.153339 });
    expect(r.sourceUrl).toBe("https://radar.cloudflare.com/security/application-layer");
  });

  it("l7_attack_trend_from is normalized, not counts", () => {
    const r = parseRadar("l7_attack_trend_from", fixture("l7_attack_trend_from"), TW);
    expect(r.unit).toBe("normalized");
    expect(r.scope).toContain("非次數");
    expect(r.scope).toContain("源自台灣");
    expect(r.data).toHaveLength(7);
    expect(r.data[0]).toEqual({ label: "2026-10-16", value: 0.585832 });
  });

  it("outages maps annotations to events", () => {
    const r = parseRadar("outages", fixture("outages"), TW);
    expect(r.unit).toBe("events");
    expect(r.data).toEqual([]);
    expect(r.events).toHaveLength(2);
    expect(r.events![0]).toMatchObject({ date: "2024-04-03" });
    expect(r.events![0]!.title).toContain("earthquake");
    expect(r.note).toBeUndefined();
    expect(r.sourceUrl).toBe("https://radar.cloudflare.com/outage-center");
  });

  it("traffic_anomalies: empty list => data [] and 此期間無紀錄", () => {
    const r = parseRadar("traffic_anomalies", fixture("traffic_anomalies"), TW);
    expect(r.data).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.note).toBe("此期間無紀錄");
    expect(r.sourceUrl).toBe("https://radar.cloudflare.com/tw");
  });

  it("bgp_hijacks", () => {
    const r = parseRadar("bgp_hijacks", fixture("bgp_hijacks"), TW);
    expect(r.scope).toBe("近 28 天涉及台灣 ASN 的 BGP 劫持事件");
    expect(r.events).toHaveLength(2);
    expect(r.events![0]!.date).toBe("2026-10-09");
    expect(r.events![0]!.title).toContain("AS134823");
    expect(r.events![0]!.title).toContain("103.177.32.0/23");
    expect(r.events![0]!.detail).toContain("AS38042");
  });

  it("internet_quality: bandwidth in data, latency in note", () => {
    const r = parseRadar("internet_quality", fixture("internet_quality"), TW);
    expect(r.unit).toBe("mbps");
    expect(r.data).toEqual([
      { label: "下載頻寬 (Mbps)", value: 111.705342 },
      { label: "上傳頻寬 (Mbps)", value: 35.585147 },
    ]);
    expect(r.note).toContain("33.7 ms");
    expect(r.period).toBe("2026-07-25 ~ 2026-10-23");
  });

  it("bot_vs_human", () => {
    const r = parseRadar("bot_vs_human", fixture("bot_vs_human"), TW);
    expect(r.data).toEqual([
      { label: "人類", value: 66.857579 },
      { label: "機器人", value: 33.142421 },
    ]);
  });

  it("ai_crawlers", () => {
    const r = parseRadar("ai_crawlers", fixture("ai_crawlers"), TW);
    expect(r.data[0]).toEqual({ label: "ClaudeBot", value: 14.818327 });
    expect(r.scope).toContain("AI 爬蟲");
  });

  it("email_threats", () => {
    const r = parseRadar("email_threats", fixture("email_threats"), {});
    expect(r.scope).toBe("全球郵件中惡意郵件占比");
    expect(r.data.find((d) => d.label === "惡意郵件")).toEqual({ label: "惡意郵件", value: 7.71446 });
  });

  it("domain_rank", () => {
    const r = parseRadar("domain_rank", fixture("domain_rank"), { domain: "cloudflare.com" });
    expect(r.unit).toBe("rank");
    expect(r.data).toEqual([{ label: "cloudflare.com", value: 4 }]);
    expect(r.note).toContain("Technology");
    expect(r.sourceUrl).toBe("https://radar.cloudflare.com/domains/domain/cloudflare.com");
  });

  it("domain_rank with only a bucket (small domain) has no data and says so", () => {
    const r = parseRadar(
      "domain_rank",
      { success: true, result: { details_0: { bucket: "50000", categories: [] }, meta: {} } },
      { domain: "example.com.tw" },
    );
    expect(r.data).toEqual([]);
    expect(r.note).toContain("前 50000 名");
  });

  it("every tool parses its fixture without throwing", () => {
    for (const name of RADAR_TOOL_NAMES) {
      const r = parseRadar(name, fixture(name), { ...TW, domain: "cloudflare.com", compareLastWeek: true });
      expect(r.title && r.scope && r.period && r.sourceUrl).toBeTruthy();
    }
  });

  it("throws on a body without result", () => {
    expect(() => parseRadar("attackers_of", { success: true }, TW)).toThrow();
  });
});

describe("radarQuery", () => {
  const makeEnv = (kv: { get?: (k: string) => Promise<unknown>; put?: (k: string, v: string) => Promise<void> } = {}) => {
    const store = new Map<string, string>();
    const KV = {
      get: vi.fn(kv.get ?? (async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null))),
      put: vi.fn(kv.put ?? (async (k: string, v: string) => void store.set(k, v))),
    };
    return { env: { CF_API_TOKEN: "tok", KV } as never, KV };
  };
  const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse(fixture("bot_vs_human")));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("miss: fetches with the bearer token, caches 600 s, then hits", async () => {
    const { env, KV } = makeEnv();
    const first = await radarQuery(env, "bot_vs_human", TW);
    expect(first.cacheHit).toBe(false);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/radar/http/summary/bot_class?location=TW&dateRange=7d");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer tok" });
    expect(KV.put).toHaveBeenCalledWith(
      "radar:bot_vs_human:location=TW&dateRange=7d",
      expect.any(String),
      { expirationTtl: 600 },
    );
    const second = await radarQuery(env, "bot_vs_human", TW);
    expect(second.cacheHit).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("domain_rank cache keys differ per domain", async () => {
    const { env, KV } = makeEnv();
    fetchMock.mockImplementation(async () => okResponse(fixture("domain_rank")));
    await radarQuery(env, "domain_rank", { domain: "a.com" });
    await radarQuery(env, "domain_rank", { domain: "b.com" });
    const keys = KV.put.mock.calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failing KV (get and put) never fails the query", async () => {
    const { env } = makeEnv({
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    });
    const r = await radarQuery(env, "bot_vs_human", TW);
    expect(r.cacheHit).toBe(false);
    expect(r.data).toHaveLength(2);
  });

  it("surfaces Radar API errors", async () => {
    const { env, KV } = makeEnv();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 }),
    );
    await expect(radarQuery(env, "bot_vs_human", TW)).rejects.toThrow("403");
    expect(KV.put).not.toHaveBeenCalled();
  });

  it("passes an abort signal to fetch", async () => {
    const { env } = makeEnv();
    const ac = new AbortController();
    await radarQuery(env, "bot_vs_human", TW, ac.signal);
    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
    ac.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("buildRadarTools", () => {
  const events: TraceEvent[] = [];
  const makeCtx = (signal = new AbortController().signal) => {
    const KV = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    return { env: { CF_API_TOKEN: "t", KV }, emit: (e: TraceEvent) => events.push(e), signal } as unknown as RunContext;
  };
  const call = (t: unknown, input: unknown, toolCallId = "span/call-1") =>
    (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId, messages: [] });
  beforeEach(() => {
    events.length = 0;
    setAttrs.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns only the requested tools", () => {
    const tools = buildRadarTools(makeCtx(), ["outages", "bgp_hijacks"]);
    expect(Object.keys(tools)).toEqual(["outages", "bgp_hijacks"]);
  });

  it("bad input RETURNS {error} instead of rejecting", async () => {
    const tools = buildRadarTools(makeCtx(), ["attackers_of", "domain_rank"]);
    expect(await call(tools.attackers_of, { location: "Japan" })).toEqual({
      error: "location 必須是 ISO 3166-1 alpha-2 代碼，例如 TW、JP、US",
    });
    expect(await call(tools.domain_rank, { domain: "https://x.com" })).toMatchObject({ error: expect.any(String) });
    expect(events).toEqual([]);
  });

  it("an HTTP failure returns {error}", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const tools = buildRadarTools(makeCtx(), ["bot_vs_human"]);
    expect(await call(tools.bot_vs_human, {})).toMatchObject({ error: expect.stringContaining("500") });
  });

  it("emits a bar chart on the tool's span id and sets span attributes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture("attackers_of")), { status: 200 })));
    const tools = buildRadarTools(makeCtx(), ["attackers_of"]);
    const out = (await call(tools.attackers_of, { location: "tw", compareLastWeek: true }, "agent/tc-7")) as Record<string, unknown>;
    expect(out).not.toHaveProperty("cacheHit");
    expect(out.scope).toContain("攻擊台灣的來源國家");
    expect(events).toHaveLength(1);
    const chart = events[0] as Extract<TraceEvent, { type: "chart" }>;
    expect(chart.spanId).toBe("agent/tc-7");
    expect(chart.chart).toMatchObject({ kind: "bar", unit: "percent", period: "2026-10-16 ~ 2026-10-23" });
    expect(chart.chart.data[0]).toEqual({ label: "美國", value: 22.605155 }); // no `previous` in chart data
    expect(setAttrs).toHaveBeenCalledWith({
      "cache.hit": false,
      "radar.endpoint": "attacks/layer7/top/locations/origin",
    });
  });

  it("normalized series are drawn as a line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture("l7_attack_trend_from")), { status: 200 })));
    const tools = buildRadarTools(makeCtx(), ["l7_attack_trend_from"]);
    await call(tools.l7_attack_trend_from, {});
    expect((events[0] as Extract<TraceEvent, { type: "chart" }>).chart.kind).toBe("line");
  });

  it("no chart for empty data (events / empty results)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture("traffic_anomalies")), { status: 200 })));
    const tools = buildRadarTools(makeCtx(), ["traffic_anomalies"]);
    const out = (await call(tools.traffic_anomalies, {})) as { note?: string };
    expect(out.note).toBe("此期間無紀錄");
    expect(events).toEqual([]);
  });

  it("rethrows when the run was aborted", async () => {
    const ac = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    }));
    const tools = buildRadarTools(makeCtx(ac.signal), ["bot_vs_human"]);
    await expect(call(tools.bot_vs_human, {})).rejects.toThrow();
  });

  it("covers every tool name", () => {
    const tools = buildRadarTools(makeCtx(), [...RADAR_TOOL_NAMES] as RadarToolName[]);
    expect(Object.keys(tools)).toHaveLength(14);
  });
});
