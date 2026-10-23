import { docsAgent } from "./defs/docs";
import { kbAgent } from "./defs/knowledge-base";
import { threatIntelAgent } from "./defs/threat-intel";
import type { AgentDef } from "./runtime";
import type { AgentId } from "./ids";

export const AGENTS: Record<AgentId, AgentDef> = {
  "knowledge-base": kbAgent,
  "cloudflare-docs": docsAgent,
  "threat-intel": threatIntelAgent,
};
