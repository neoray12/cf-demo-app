// Pure dispatcher for the threat-intel agent: which Radar analysts to run for a question, picked by keyword rules
// (no model call). Replaces the root's old planning step (plan sentence + `brief` tool call). No server imports.
import { COMPARE_RE, prefetchLocation } from "./radar-prefetch";

export type AnalystKind = "attack" | "network" | "bot";

export interface DispatchPlan {
  /** Analysts to run in parallel, in a stable order (attack, network, bot); never empty. */
  analysts: AnalystKind[];
  /** ISO 3166-1 alpha-2 code; TW when the question names no known country. */
  location: string;
  compareLastWeek: boolean;
  /** A domain named in the question (implies the bot analyst, for domain_rank). */
  domain?: string;
}

const ANALYST_RULES: Array<[AnalystKind, RegExp]> = [
  ["attack", /攻擊|攻撃|攻击|attack|ddos|\bwaf\b|駭客|黑客|hacker|威脅|威胁|threat|來源國家|来源国家/i],
  ["network", /斷網|断网|中斷|中断|outage|\bbgp\b|劫持|hijack|網速|网速|品質|品质|\bisp\b/i],
  ["bot", /機器人|机器人|爬蟲|爬虫|\bbots?\b|ai crawler|crawler|郵件|邮件|e-?mail|釣魚|钓鱼|phishing|網域排名|域名排名|domain rank/i],
];

const DOMAIN_TOKEN_RE = /[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** The first domain-looking token of the question (lower-cased), e.g. "example.com" in 「example.com 的排名？」. */
export function dispatchDomain(question: string): string | undefined {
  for (const m of question.matchAll(DOMAIN_TOKEN_RE)) {
    const token = m[0].toLowerCase().replace(/^[.-]+|[.-]+$/g, "");
    if (DOMAIN_RE.test(token) && !token.includes("..")) return token;
  }
  return undefined;
}

/** Keyword dispatcher: every analyst whose keywords match (a domain implies `bot`); attack when nothing matches. */
export function planDispatch(question: string): DispatchPlan {
  const domain = dispatchDomain(question);
  const analysts = ANALYST_RULES.filter(([kind, re]) => re.test(question) || (kind === "bot" && domain !== undefined)).map(
    ([kind]) => kind,
  );
  return {
    analysts: analysts.length > 0 ? analysts : ["attack"],
    location: prefetchLocation(question),
    compareLastWeek: COMPARE_RE.test(question),
    ...(domain ? { domain } : {}),
  };
}
