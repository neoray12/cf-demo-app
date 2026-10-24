// Client-side catalog of the Agents demo (sidebar, pages, labels).
// NOTE: must stay free of server imports — never import ./registry here.
import { BookOpen, FileSearch, Radar, type LucideIcon } from "lucide-react";
import type { AgentId } from "./ids";
import type { ModelKey } from "./models";

export interface AgentCatalogEntry {
  id: AgentId;
  path: string;
  icon: LucideIcon;
  /** Short sidebar label (`agents.nav.*`). */
  navKey: string;
  titleKey: string;
  descKey: string;
  defaultModel: ModelKey;
  suggestionKeys: string[];
  features: { workspace: boolean; charts: boolean; grounding: boolean };
}

const suggestions = (ns: string, n: number) => Array.from({ length: n }, (_, i) => `agents.${ns}.suggestions.s${i + 1}`);

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    id: "knowledge-base",
    path: "/agents/knowledge-base",
    icon: BookOpen,
    navKey: "agents.nav.knowledgeBase",
    titleKey: "agents.knowledgeBase.title",
    descKey: "agents.knowledgeBase.desc",
    defaultModel: "glm-5.3-flash",
    suggestionKeys: suggestions("knowledgeBase", 3),
    features: { workspace: true, charts: false, grounding: true },
  },
  {
    id: "cloudflare-docs",
    path: "/agents/cloudflare-docs",
    icon: FileSearch,
    navKey: "agents.nav.cloudflareDocs",
    titleKey: "agents.cloudflareDocs.title",
    descKey: "agents.cloudflareDocs.desc",
    defaultModel: "glm-5.3-flash",
    suggestionKeys: suggestions("cloudflareDocs", 4),
    features: { workspace: false, charts: false, grounding: false },
  },
  {
    id: "threat-intel",
    path: "/agents/threat-intel",
    icon: Radar,
    navKey: "agents.nav.threatIntel",
    titleKey: "agents.threatIntel.title",
    descKey: "agents.threatIntel.desc",
    defaultModel: "glm-5.3-flash",
    suggestionKeys: suggestions("threatIntel", 5),
    features: { workspace: false, charts: true, grounding: false },
  },
];

export function findAgent(id: string): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find((a) => a.id === id);
}

/** The dashboard's Agents tab (docs link: dash.cloudflare.com/?to=/:account/agents), on the Neo-Cloudflare account. */
export const AGENTS_DASHBOARD_URL = "https://dash.cloudflare.com/5efa272dc28e4e3933324c44165b6dbe/agents";

/**
 * Friendly i18n labels for span names: tools (`execute_tool`) and agents/subagents (`invoke_agent` functionId).
 * Keep in sync with src/lib/agents/defs/* and src/lib/agents/tools/*.
 */
export const AGENT_TOOL_LABEL_KEYS: Record<string, string> = {
  // tools
  search_docs: "agents.tools.search_docs",
  translate_query: "agents.tools.translate_query",
  rerank_results: "agents.tools.rerank_results",
  read_doc_page: "agents.tools.read_doc_page",
  research: "agents.tools.research",
  overview: "agents.tools.overview",
  search_kb: "agents.tools.search_kb",
  calc_annual_leave: "agents.tools.calc_annual_leave",
  calc_overtime_pay: "agents.tools.calc_overtime_pay",
  calc_travel_cost: "agents.tools.calc_travel_cost",
  brief: "agents.tools.brief",
  dispatch: "agents.tools.dispatch",
  attackers_of: "agents.tools.attackers_of",
  attack_targets_from: "agents.tools.attack_targets_from",
  l7_attacks_from: "agents.tools.l7_attacks_from",
  l3_attacks_mitigated_in: "agents.tools.l3_attacks_mitigated_in",
  top_attacked_industries: "agents.tools.top_attacked_industries",
  l7_attack_trend_from: "agents.tools.l7_attack_trend_from",
  outages: "agents.tools.outages",
  traffic_anomalies: "agents.tools.traffic_anomalies",
  bgp_hijacks: "agents.tools.bgp_hijacks",
  internet_quality: "agents.tools.internet_quality",
  bot_vs_human: "agents.tools.bot_vs_human",
  ai_crawlers: "agents.tools.ai_crawlers",
  email_threats: "agents.tools.email_threats",
  domain_rank: "agents.tools.domain_rank",
  // agents / subagents
  "kb-agent": "agents.subagents.kb-agent",
  "docs-agent": "agents.subagents.docs-agent",
  "threat-intel-agent": "agents.subagents.threat-intel-agent",
  "docs-researcher": "agents.subagents.docs-researcher",
  "attack-analyst": "agents.subagents.attack-analyst",
  "network-analyst": "agents.subagents.network-analyst",
  "bot-analyst": "agents.subagents.bot-analyst",
  "grounding-checker": "agents.subagents.grounding-checker",
};
