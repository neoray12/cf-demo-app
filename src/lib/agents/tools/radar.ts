// Cloudflare Radar tools for the threat-intel agent. Every tool is a whitelisted wrapper around ONE fixed
// endpoint (the model never builds a URL), and every result carries `scope`/`unit`/`period` so the model can
// describe the numbers exactly as Radar means them (see spec §3.4: `location` does NOT always mean "attacked").
// Span start/end for tool calls come from the runtime's execute wrapper — tools only emit charts.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { errorMessage, type AgentEnv, type RunContext } from "../runtime";
import { setActiveSpanAttributes } from "../tracing";

export const RADAR_TOOL_NAMES = [
  "attackers_of",
  "attack_targets_from",
  "l7_attacks_from",
  "l3_attacks_mitigated_in",
  "top_attacked_industries",
  "l7_attack_trend_from",
  "outages",
  "traffic_anomalies",
  "bgp_hijacks",
  "internet_quality",
  "bot_vs_human",
  "ai_crawlers",
  "email_threats",
  "domain_rank",
] as const;
export type RadarToolName = (typeof RADAR_TOOL_NAMES)[number];

export interface RadarResult {
  title: string;
  scope: string;
  unit: "percent" | "normalized" | "mbps" | "ms" | "rank" | "events";
  period: string;
  data: Array<{ label: string; value: number; previous?: number }>;
  events?: Array<{ date: string; title: string; detail?: string }>;
  sourceUrl: string;
  note?: string;
}

const RADAR_BASE = "https://api.cloudflare.com/client/v4/radar/";
const RADAR_TIMEOUT_MS = 20_000;
const CACHE_TTL_S = 600; // KV's minimum TTL is 60 s
const NO_RECORDS = "此期間無紀錄";
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

// ---------------------------------------------------------------------------
// input normalisation

export function normalizeLocation(input: string | undefined): string {
  if (input === undefined || input.trim() === "") return "TW";
  const v = input.trim();
  if (/^[a-z]{2}$/i.test(v)) return v.toUpperCase();
  throw new Error("location 必須是 ISO 3166-1 alpha-2 代碼，例如 TW、JP、US");
}

function normalizeDomain(input: unknown): string {
  const v = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!DOMAIN_RE.test(v)) throw new Error("domain 必須是網域名稱（例如 example.com），不可包含 https://、路徑或空白");
  return v;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

let regionNames: Intl.DisplayNames | undefined;
function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["zh-TW"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// ---------------------------------------------------------------------------
// request

export function buildRadarRequest(
  name: RadarToolName,
  input: Record<string, unknown>,
): { path: string; params: URLSearchParams } {
  const params = new URLSearchParams();
  const compare = input.compareLastWeek === true;
  const location = () => normalizeLocation(str(input.location));
  const week = () => {
    params.append("dateRange", "7d");
    if (compare) params.append("dateRange", "7dControl");
  };

  switch (name) {
    case "attackers_of":
      params.set("location", location());
      week();
      params.set("limit", "10");
      return { path: "attacks/layer7/top/locations/origin", params };
    case "attack_targets_from":
      params.set("location", location());
      params.set("dateRange", "7d");
      params.set("limit", "10");
      return { path: "attacks/layer7/top/locations/target", params };
    case "l7_attacks_from": {
      const dimension = str(input.dimension) ?? "mitigation_product";
      if (dimension !== "mitigation_product" && dimension !== "http_method") {
        throw new Error("dimension 只能是 mitigation_product 或 http_method");
      }
      params.set("location", location());
      week();
      return { path: `attacks/layer7/summary/${dimension}`, params };
    }
    case "l3_attacks_mitigated_in":
      params.set("location", location());
      week();
      return { path: "attacks/layer3/summary/vector", params };
    case "top_attacked_industries":
      // Deliberately no `location`: its meaning on industry rankings is layer-dependent. Global ranking only.
      params.set("dateRange", "7d");
      params.set("limit", "10");
      return { path: "attacks/layer7/top/industry", params };
    case "l7_attack_trend_from":
      params.set("location", location());
      params.set("dateRange", "7d");
      params.set("aggInterval", "1d");
      return { path: "attacks/layer7/timeseries", params };
    case "outages":
      params.set("location", location());
      params.set("limit", "10");
      if (input.recentOnly === true) params.set("dateRange", "52w");
      return { path: "annotations/outages", params };
    case "traffic_anomalies":
      params.set("location", location());
      params.set("dateRange", "28d");
      params.set("limit", "10");
      return { path: "traffic_anomalies", params };
    case "bgp_hijacks":
      params.set("involvedCountry", location());
      params.set("dateRange", "28d");
      params.set("per_page", "10");
      return { path: "bgp/hijacks/events", params };
    case "internet_quality":
      params.set("location", location());
      return { path: "quality/speed/summary", params };
    case "bot_vs_human":
      params.set("location", location());
      params.set("dateRange", "7d");
      return { path: "http/summary/bot_class", params };
    case "ai_crawlers":
      params.set("location", location());
      params.set("dateRange", "7d");
      return { path: "ai/bots/summary/user_agent", params };
    case "email_threats":
      params.set("dateRange", "7d");
      return { path: "email/security/summary/malicious", params };
    case "domain_rank":
      return { path: `ranking/domain/${normalizeDomain(input.domain)}`, params };
  }
}

// ---------------------------------------------------------------------------
// response parsing

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}
function ymd(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 10) : "";
}

function rangeOf(meta: Json | undefined, index: number): string | undefined {
  const r = obj(arr(meta?.dateRange)[index]);
  if (!r) return undefined;
  const start = ymd(r.startTime);
  const end = ymd(r.endTime);
  return start && end ? `${start} ~ ${end}` : undefined;
}

const LABELS: Record<string, string> = {
  human: "人類",
  bot: "機器人",
  MALICIOUS: "惡意郵件",
  NOT_MALICIOUS: "非惡意郵件",
  other: "其他",
};

interface ToolMeta {
  title: string;
  scope: string;
  sourceUrl: string;
}

function toolMeta(name: RadarToolName, input: Record<string, unknown>): ToolMeta {
  const needsLocation = name !== "top_attacked_industries" && name !== "email_threats" && name !== "domain_rank";
  const loc = needsLocation ? normalizeLocation(str(input.location)) : "";
  const cn = needsLocation ? countryName(loc) : "";
  const cc = loc.toLowerCase();
  const radar = "https://radar.cloudflare.com/";
  switch (name) {
    case "attackers_of":
      return {
        title: `攻擊${cn}的來源國家 Top 10`,
        scope: `攻擊${cn}的來源國家（應用層）`,
        sourceUrl: `${radar}security/application-layer/${cc}`,
      };
    case "attack_targets_from":
      return {
        title: `源自${cn}的攻擊目標國家 Top 10`,
        scope: `源自${cn}的攻擊目標國家（應用層）`,
        sourceUrl: `${radar}security/application-layer/${cc}`,
      };
    case "l7_attacks_from": {
      const dimension = str(input.dimension) ?? "mitigation_product";
      const label = dimension === "http_method" ? "HTTP 方法" : "緩解產品";
      return {
        title: `源自${cn}的應用層攻擊（依${label}）`,
        scope: `源自${cn}的應用層攻擊，依${label}分布`,
        sourceUrl: `${radar}security/application-layer/${cc}`,
      };
    }
    case "l3_attacks_mitigated_in":
      return {
        title: `在${cn}資料中心緩解的網路層攻擊手法`,
        scope: `在${cn}資料中心緩解的網路層攻擊手法`,
        sourceUrl: `${radar}security/network-layer/${cc}`,
      };
    case "top_attacked_industries":
      return {
        title: "全球最常被攻擊的產業 Top 10",
        scope: "全球最常被攻擊的產業（應用層）",
        sourceUrl: `${radar}security/application-layer`,
      };
    case "l7_attack_trend_from":
      return {
        title: `源自${cn}的應用層攻擊量趨勢`,
        scope: `源自${cn}的應用層攻擊量趨勢（0–1 正規化，非次數）`,
        sourceUrl: `${radar}security/application-layer/${cc}`,
      };
    case "outages":
      return { title: `${cn}的網路中斷事件`, scope: `${cn}的網路中斷事件`, sourceUrl: `${radar}outage-center` };
    case "traffic_anomalies":
      return {
        title: `${cn}近 28 天的流量異常`,
        scope: `${cn}近 28 天的流量異常`,
        sourceUrl: `${radar}${cc}`,
      };
    case "bgp_hijacks":
      return {
        title: `涉及${cn} ASN 的 BGP 劫持事件`,
        scope: `近 28 天涉及${cn} ASN 的 BGP 劫持事件`,
        sourceUrl: `${radar}routing/${cc}`,
      };
    case "internet_quality":
      return {
        title: `${cn}的網路速度品質`,
        scope: `${cn}的網路速度品質（近 90 天）`,
        sourceUrl: `${radar}quality/${cc}`,
      };
    case "bot_vs_human":
      return {
        title: `${cn}的人類與機器人流量占比`,
        scope: `${cn}的 HTTP 流量中人類與機器人占比`,
        sourceUrl: `${radar}traffic/${cc}`,
      };
    case "ai_crawlers":
      return {
        title: `${cn}的 AI 爬蟲流量`,
        scope: `${cn}的 AI 爬蟲流量依 user agent 分布`,
        sourceUrl: `${radar}ai-insights`,
      };
    case "email_threats":
      return {
        title: "全球惡意郵件占比",
        scope: "全球郵件中惡意郵件占比",
        sourceUrl: `${radar}email-security`,
      };
    case "domain_rank": {
      const domain = normalizeDomain(input.domain);
      return {
        title: `${domain} 的全球排名`,
        scope: `${domain} 的全球熱門度排名與分類`,
        sourceUrl: `${radar}domains/domain/${domain}`,
      };
    }
  }
}

/** `summary_0` (+ `summary_1` for the previous week) keyed by label. */
function fromSummary(
  s0: Json | undefined,
  s1: Json | undefined,
  label: (key: string) => string = (k) => LABELS[k] ?? k,
): RadarResult["data"] {
  const out: RadarResult["data"] = [];
  for (const [key, raw] of Object.entries(s0 ?? {})) {
    const value = num(raw);
    if (value === undefined) continue;
    const previous = s1 ? num(s1[key]) : undefined;
    out.push(previous === undefined ? { label: label(key), value } : { label: label(key), value, previous });
  }
  return out;
}

/** `top_0` (+ `top_1`) lists of objects identified by `codeField`, matched across weeks by that code. */
function fromTop(
  t0: unknown[],
  t1: unknown[] | undefined,
  codeField: string | undefined,
  labelOf: (item: Json) => string,
): RadarResult["data"] {
  const prev = new Map<string, number>();
  for (const item of t1 ?? []) {
    const o = obj(item);
    const v = num(o?.value);
    const k = o ? (codeField ? str(o[codeField]) : str(o.name)) : undefined;
    if (k !== undefined && v !== undefined) prev.set(k, v);
  }
  const out: RadarResult["data"] = [];
  for (const item of t0) {
    const o = obj(item);
    const value = num(o?.value);
    if (!o || value === undefined) continue;
    const key = codeField ? str(o[codeField]) : str(o.name);
    const previous = key !== undefined && t1 ? prev.get(key) : undefined;
    out.push(
      previous === undefined ? { label: labelOf(o), value } : { label: labelOf(o), value, previous },
    );
  }
  return out;
}

export function parseRadar(name: RadarToolName, json: unknown, input: Record<string, unknown>): RadarResult {
  const result = obj(obj(json)?.result);
  if (!result) throw new Error("Radar 回傳格式不符：缺少 result");
  const meta = obj(result.meta);
  const { title, scope, sourceUrl } = toolMeta(name, input);
  const compare = input.compareLastWeek === true;
  const notes: string[] = [];
  const base = { title, scope, sourceUrl };

  const percentResult = (data: RadarResult["data"], compared: boolean): RadarResult => {
    const basis = str(obj(arr(meta?.units)[0])?.value);
    if (basis) notes.push(`占比基準：${basis}（不是絕對次數）`);
    if (compared) {
      const prevRange = rangeOf(meta, 1);
      notes.push(
        data.some((d) => d.previous !== undefined)
          ? `previous 為上一期${prevRange ? `（${prevRange}）` : ""}的同口徑占比；沒有 previous 表示上週未出現在 Radar 回傳的清單中，不代表 0`
          : "Radar 未回傳上週比較資料",
      );
    }
    if (data.length === 0) notes.push(NO_RECORDS);
    return {
      ...base,
      unit: "percent",
      period: rangeOf(meta, 0) ?? "近 7 天",
      data,
      ...(notes.length ? { note: notes.join("；") } : {}),
    };
  };

  const eventsResult = (period: string, events: NonNullable<RadarResult["events"]>): RadarResult => ({
    ...base,
    unit: "events",
    period,
    data: [],
    events,
    ...(events.length === 0 ? { note: NO_RECORDS } : {}),
  });

  switch (name) {
    case "attackers_of": {
      const data = fromTop(
        arr(result.top_0),
        compare ? arr(result.top_1) : undefined,
        "originCountryAlpha2",
        (o) => countryName(str(o.originCountryAlpha2) ?? "") || str(o.originCountryName) || "?",
      );
      return percentResult(data, compare);
    }
    case "attack_targets_from":
      return percentResult(
        fromTop(arr(result.top_0), undefined, "targetCountryAlpha2", (o) =>
          countryName(str(o.targetCountryAlpha2) ?? "") || str(o.targetCountryName) || "?",
        ),
        false,
      );
    case "top_attacked_industries":
      return percentResult(fromTop(arr(result.top_0), undefined, undefined, (o) => str(o.name) ?? "?"), false);
    case "l7_attacks_from":
    case "l3_attacks_mitigated_in":
      return percentResult(fromSummary(obj(result.summary_0), compare ? obj(result.summary_1) : undefined), compare);
    case "bot_vs_human":
    case "ai_crawlers":
    case "email_threats":
      return percentResult(fromSummary(obj(result.summary_0), undefined), false);

    case "l7_attack_trend_from": {
      const serie = obj(result.serie_0);
      const stamps = arr(serie?.timestamps);
      const data: RadarResult["data"] = [];
      arr(serie?.values).forEach((raw, i) => {
        const value = num(raw);
        if (value !== undefined) data.push({ label: ymd(stamps[i]) || String(i + 1), value });
      });
      return {
        ...base,
        unit: "normalized",
        period: rangeOf(meta, 0) ?? "近 7 天",
        data,
        note: data.length === 0 ? NO_RECORDS : "數值為 0–1 正規化（1 = 該期間最高的一天），不是攻擊次數",
      };
    }

    case "outages": {
      const events = arr(result.annotations)
        .map(obj)
        .filter((a): a is Json => a !== undefined)
        .map((a) => {
          const outage = obj(a.outage);
          const asns = arr(a.asnsDetails)
            .map((d) => str(obj(d)?.name))
            .filter(Boolean)
            .join(", ");
          const detail = [
            str(outage?.outageCause) && `原因：${str(outage?.outageCause)}`,
            str(outage?.outageType) && `類型：${str(outage?.outageType)}`,
            asns && `受影響 ASN：${asns}`,
            ymd(a.endDate) && `結束：${ymd(a.endDate)}`,
          ]
            .filter(Boolean)
            .join("；");
          return { date: ymd(a.startDate), title: str(a.description) ?? str(a.eventType) ?? "outage", ...(detail ? { detail } : {}) };
        });
      return eventsResult(input.recentOnly === true ? "近 52 週" : "全部歷史紀錄", events);
    }

    case "traffic_anomalies": {
      const events = arr(result.trafficAnomalies)
        .map(obj)
        .filter((a): a is Json => a !== undefined)
        .map((a) => {
          const where =
            str(obj(a.locationDetails)?.name) ?? str(obj(a.asnDetails)?.name) ?? str(a.type) ?? "traffic anomaly";
          const status = str(a.status);
          const end = ymd(a.endDate);
          const detail = [status && `狀態：${status}`, end && `結束：${end}`].filter(Boolean).join("；");
          return { date: ymd(a.startDate), title: `${where} 流量異常`, ...(detail ? { detail } : {}) };
        });
      return eventsResult("近 28 天", events);
    }

    case "bgp_hijacks": {
      const asnNames = new Map<number, string>();
      for (const a of arr(result.asn_info)) {
        const o = obj(a);
        const asn = num(o?.asn);
        if (asn !== undefined) asnNames.set(asn, str(o?.org_name) ?? "");
      }
      const asnLabel = (v: unknown) => {
        const n = num(v);
        return n === undefined ? "?" : `AS${n}${asnNames.get(n) ? `（${asnNames.get(n)}）` : ""}`;
      };
      const events = arr(result.events)
        .map(obj)
        .filter((e): e is Json => e !== undefined)
        .map((e) => {
          const prefixes = arr(e.prefixes).filter((p): p is string => typeof p === "string");
          const victims = arr(e.victim_asns).map(asnLabel).join(", ");
          const detail = [
            victims && `受害 ASN：${victims}`,
            num(e.confidence_score) !== undefined && `信心分數：${num(e.confidence_score)}`,
            num(e.duration) !== undefined && `持續 ${num(e.duration)} 秒`,
            e.is_stale === true && "已結束",
          ]
            .filter(Boolean)
            .join("；");
          return {
            date: ymd(e.min_hijack_ts),
            title: `${asnLabel(e.hijacker_asn)} 宣告 ${prefixes.slice(0, 3).join(", ") || "未知前綴"}`,
            ...(detail ? { detail } : {}),
          };
        });
      return eventsResult("近 28 天", events);
    }

    case "internet_quality": {
      const s = obj(result.summary_0);
      const down = num(s?.bandwidthDownload);
      const up = num(s?.bandwidthUpload);
      const data: RadarResult["data"] = [];
      if (down !== undefined) data.push({ label: "下載頻寬 (Mbps)", value: down });
      if (up !== undefined) data.push({ label: "上傳頻寬 (Mbps)", value: up });
      const fmt = (label: string, v: unknown, unit: string) => (num(v) === undefined ? undefined : `${label} ${num(v)!.toFixed(1)} ${unit}`);
      const note = [
        fmt("閒置延遲", s?.latencyIdle, "ms"),
        fmt("負載延遲", s?.latencyLoaded, "ms"),
        fmt("閒置抖動", s?.jitterIdle, "ms"),
        fmt("封包遺失", s?.packetLoss, "%"),
      ]
        .filter(Boolean)
        .join("；");
      return {
        ...base,
        unit: "mbps",
        period: rangeOf(meta, 0) ?? "近 90 天",
        data,
        note: data.length === 0 ? NO_RECORDS : `延遲（ms）：${note}`,
      };
    }

    case "domain_rank": {
      const d = obj(result.details_0);
      const domain = normalizeDomain(input.domain);
      const rank = num(d?.rank);
      const bucket = str(d?.bucket) ?? (num(d?.bucket) !== undefined ? String(num(d?.bucket)) : undefined);
      const categories = arr(d?.categories)
        .map((c) => str(obj(c)?.name))
        .filter(Boolean)
        .join("、");
      const notes: string[] = [];
      if (rank === undefined) notes.push(bucket ? `Radar 只提供排名區間：前 ${bucket} 名，沒有精確名次` : NO_RECORDS);
      if (categories) notes.push(`分類：${categories}`);
      return {
        ...base,
        unit: "rank",
        period: rangeOf(meta, 0) ?? "最新",
        data: rank === undefined ? [] : [{ label: domain, value: rank }],
        ...(notes.length ? { note: notes.join("；") } : {}),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// query (KV cache + fetch)

export async function radarQuery(
  env: AgentEnv,
  name: RadarToolName,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RadarResult & { cacheHit: boolean }> {
  const { path, params } = buildRadarRequest(name, input);
  // The path carries arguments too (domain, dimension), so the key must include it.
  const key = `radar:${name}:${path}?${params.toString()}`;

  try {
    const hit = (await env.KV.get(key, "json")) as RadarResult | null;
    if (hit && typeof hit === "object" && Array.isArray(hit.data)) return { ...hit, cacheHit: true };
  } catch {
    // a cache failure must never fail the tool
  }

  const timeout = AbortSignal.timeout(RADAR_TIMEOUT_MS);
  const res = await fetch(`${RADAR_BASE}${path}${params.size > 0 ? `?${params}` : ""}`, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
  } | null;
  if (!res.ok || json?.success === false) {
    throw new Error(`Radar API 失敗 (${res.status}): ${json?.errors?.[0]?.message ?? "unexpected response"}`);
  }
  const parsed = parseRadar(name, json, input);

  try {
    await env.KV.put(key, JSON.stringify(parsed), { expirationTtl: CACHE_TTL_S });
  } catch {
    // ignore
  }
  return { ...parsed, cacheHit: false };
}

// ---------------------------------------------------------------------------
// tools

const locationSchema = z
  .string()
  .optional()
  .describe("ISO 3166-1 alpha-2 country code, e.g. TW, JP, US. Defaults to TW");
const compareSchema = z
  .boolean()
  .optional()
  .describe("true = also return last week's value as `previous` (week-over-week comparison)");

const SCOPE_NOTE =
  "Returns {title, scope, unit, period, data, events?, sourceUrl, note?}. Describe numbers exactly as `scope` says, use `period` and read numbers by `unit` (percent = share, normalized = 0-1 relative value, mbps/ms = measurement, rank = popularity rank, events = list of events); percent/normalized values are never absolute counts.";

const TOOL_DEFS: Record<RadarToolName, { description: string; inputSchema: z.ZodType<Record<string, unknown>> }> = {
  attackers_of: {
    description: `Top 10 countries that application-layer (L7) attacks AGAINST the given location come from, as % of mitigated requests. ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema, compareLastWeek: compareSchema }),
  },
  attack_targets_from: {
    description: `Top 10 countries targeted by application-layer attacks that ORIGINATE from the given location (the location is the attacker side, not the victim). ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema }),
  },
  l7_attacks_from: {
    description: `Application-layer attacks ORIGINATING from the given location (NOT attacks on it), as a distribution by mitigation product or HTTP method. ${SCOPE_NOTE}`,
    inputSchema: z.object({
      location: locationSchema,
      dimension: z.enum(["mitigation_product", "http_method"]).optional().describe("Breakdown dimension, default mitigation_product"),
      compareLastWeek: compareSchema,
    }),
  },
  l3_attacks_mitigated_in: {
    description: `Network-layer (L3/4) attack vectors mitigated at Cloudflare data centers located in the given location (share by bytes). ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema, compareLastWeek: compareSchema }),
  },
  top_attacked_industries: {
    description: `Global ranking of the most attacked industries (application layer). Worldwide only: Radar cannot give a per-country or per-industry absolute attack count. ${SCOPE_NOTE}`,
    inputSchema: z.object({}),
  },
  l7_attack_trend_from: {
    description: `Daily trend of application-layer attacks ORIGINATING from the given location, normalised to 0-1 (not counts). ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema }),
  },
  outages: {
    description: `Internet outage events recorded by Radar for the given location. ${SCOPE_NOTE}`,
    inputSchema: z.object({
      location: locationSchema,
      recentOnly: z.boolean().optional().describe("true = only the last 52 weeks; default is the full history"),
    }),
  },
  traffic_anomalies: {
    description: `Traffic anomalies detected for the given location in the last 28 days (an empty list means none). ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema }),
  },
  bgp_hijacks: {
    description: `BGP hijack events in the last 28 days involving ASNs of the given country (can take ~4 s). ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema }),
  },
  internet_quality: {
    description: `Internet speed quality (download/upload bandwidth in Mbps, latency in ms) for the given location, last 90 days. ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema }),
  },
  bot_vs_human: {
    description: `Share of human vs bot HTTP traffic for the given location, last 7 days. ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema }),
  },
  ai_crawlers: {
    description: `AI crawler traffic by user agent for the given location, last 7 days (share of AI-bot traffic). ${SCOPE_NOTE}`,
    inputSchema: z.object({ location: locationSchema }),
  },
  email_threats: {
    description: `Share of malicious email worldwide, last 7 days. ${SCOPE_NOTE}`,
    inputSchema: z.object({}),
  },
  domain_rank: {
    description: `Global popularity rank and categories of a domain; small domains only return a rank bucket. ${SCOPE_NOTE}`,
    inputSchema: z.object({ domain: z.string().describe("Bare domain such as example.com (no scheme, no path)") }),
  },
};

export function buildRadarTools(ctx: RunContext, names: RadarToolName[]): ToolSet {
  const tools: ToolSet = {};
  for (const name of names) {
    const def = TOOL_DEFS[name];
    tools[name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input: Record<string, unknown>, options) => {
        try {
          const { path } = buildRadarRequest(name, input);
          const { cacheHit, ...result } = await radarQuery(ctx.env, name, input, ctx.signal);
          setActiveSpanAttributes({ "cache.hit": cacheHit, "radar.endpoint": path });
          if (result.data.length > 0) {
            ctx.emit({
              type: "chart",
              spanId: options.toolCallId,
              chart: {
                kind: result.unit === "normalized" ? "line" : "bar",
                title: result.title,
                unit: result.unit,
                period: result.period,
                data: result.data.map(({ label, value }) => ({ label, value })),
                sourceUrl: result.sourceUrl,
              },
            });
          }
          return result;
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return { error: errorMessage(err) };
        }
      },
    });
  }
  return tools;
}
