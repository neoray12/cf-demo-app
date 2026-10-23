import { docsAgent } from "./defs/docs";
import type { AgentDef } from "./runtime";
import type { AgentId } from "./ids";

// Partial until every agent exists; the route answers 404 for ids missing here.
export const AGENTS: Partial<Record<AgentId, AgentDef>> = {
  "cloudflare-docs": docsAgent,
};
