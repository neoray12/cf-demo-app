// Pure helpers for the threat-intel prefetch: which ONE Radar tool to run at t=0 for a question, and how to hand
// its result to the analysts as compact text. No server imports.
import type { RadarResult, RadarToolName } from "./radar";

export interface RadarPrefetchPlan {
  tool: Extract<RadarToolName, "attackers_of" | "bot_vs_human" | "outages">;
  input: Record<string, unknown>;
}

export const COMPARE_RE = /上週|上周|比較|比较|變化|变化|last week|compar|week[- ]over[- ]week/i;
const ATTACK_RE = /攻擊|攻撃|攻击|attack|ddos|waf|駭客|黑客|hacker/i;
const BOT_RE = /機器人|机器人|爬蟲|爬虫|\bbots?\b|crawler/i;
const NETWORK_RE = /斷網|断网|中斷|中断|outage|bgp|劫持|網速|网速|品質|品质/i;

// Country mention -> ISO code. The earliest mention in the question wins; no mention = TW.
const COUNTRIES: Array<[RegExp, string]> = [
  [/台灣|臺灣|taiwan/i, "TW"],
  [/日本|japan/i, "JP"],
  [/美國|美国|united states|\bUSA\b|america/i, "US"],
  [/新加坡|singapore/i, "SG"],
  [/香港|hong kong/i, "HK"],
  [/韓國|韩国|南韓|south korea|\bkorea\b/i, "KR"],
  [/中國|中国|\bchina\b/i, "CN"],
  [/英國|英国|united kingdom|\buk\b/i, "GB"],
  [/德國|德国|germany/i, "DE"],
  [/印度|\bindia\b/i, "IN"],
  [/俄羅斯|俄罗斯|russia/i, "RU"],
];

export function prefetchLocation(text: string): string {
  let best: { index: number; code: string } | undefined;
  for (const [re, code] of COUNTRIES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { index: m.index, code };
  }
  return best?.code ?? "TW";
}

/** The Radar tool + arguments to run at t=0: attacks (default), bots, or outages, picked by keywords. */
export function planRadarPrefetch(question: string): RadarPrefetchPlan {
  const location = prefetchLocation(question);
  if (ATTACK_RE.test(question)) {
    return { tool: "attackers_of", input: { location, ...(COMPARE_RE.test(question) ? { compareLastWeek: true } : {}) } };
  }
  if (BOT_RE.test(question)) return { tool: "bot_vs_human", input: { location } };
  if (NETWORK_RE.test(question)) return { tool: "outages", input: { location, recentOnly: true } };
  return { tool: "attackers_of", input: { location, ...(COMPARE_RE.test(question) ? { compareLastWeek: true } : {}) } };
}

const SUMMARY_MAX_ROWS = 10;
const SUMMARY_MAX_EVENTS = 6;

const num = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * Compact text of a prefetched Radar result for the analysts' prompts (they must not call the same tool with the
 * same arguments again). A failed prefetch says so and leaves the analysts free to query it themselves.
 */
export function prefetchSummary(plan: RadarPrefetchPlan, output: RadarResult | { error: string } | undefined): string {
  const call = `${plan.tool}(${JSON.stringify(plan.input)})`;
  if (!output) return `預先查詢 ${call} 沒有結果；需要時請自行呼叫工具。`;
  if ("error" in output) return `預先查詢 ${call} 失敗（${output.error}）；需要時請自行呼叫工具。`;
  const lines = [
    `已預先取得：${call} 的結果（相同工具、相同參數不要再呼叫，直接引用下列數字）。`,
    `title：${output.title}`,
    `scope：${output.scope}`,
    `period：${output.period}`,
    `unit：${output.unit}`,
  ];
  if (output.data.length > 0) {
    const rows = output.data
      .slice(0, SUMMARY_MAX_ROWS)
      .map((d) => (d.previous === undefined ? `${d.label} ${num(d.value)}` : `${d.label} ${num(d.value)}（上週 ${num(d.previous)}）`));
    lines.push(`data：${rows.join("；")}`);
  }
  if (output.events && output.events.length > 0) {
    const ev = output.events.slice(0, SUMMARY_MAX_EVENTS).map((e) => `${e.date} ${e.title}`);
    lines.push(`events（共 ${output.events.length} 筆）：${ev.join("；")}`);
  }
  if (output.data.length === 0 && !(output.events && output.events.length > 0)) lines.push("data：此期間無紀錄");
  if (output.note) lines.push(`note：${output.note}`);
  lines.push(`sourceUrl：${output.sourceUrl}`);
  return lines.join("\n");
}
