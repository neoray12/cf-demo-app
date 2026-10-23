export const AGENT_IDS = ["knowledge-base", "cloudflare-docs", "threat-intel"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
