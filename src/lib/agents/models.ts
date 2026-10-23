// Workers AI model catalog for the Agents demo.
// NOTE: no runtime imports — client components import this file.

export type ModelKey = "glm-5.3-flash" | "kimi-k2.6" | "kimi-k2.6-thinking" | "glm-5.3";

export interface AgentModel {
  key: ModelKey;
  workersAiId: string;
  reasoningEffort: "low" | "none" | "high";
  maxTokens: number;
  labelKey: string;
  slow: boolean;
  ttftHint: string;
}

export const AGENT_MODELS: Record<ModelKey, AgentModel> = {
  "glm-5.3-flash": {
    key: "glm-5.3-flash",
    workersAiId: "@cf/zai-org/glm-5.3-flash",
    reasoningEffort: "low",
    maxTokens: 4000,
    labelKey: "agents.models.glm-5.3-flash",
    slow: false,
    ttftHint: "0.8–2.8s",
  },
  "kimi-k2.6": {
    key: "kimi-k2.6",
    workersAiId: "@cf/moonshotai/kimi-k2.6",
    reasoningEffort: "none",
    maxTokens: 4000,
    labelKey: "agents.models.kimi-k2.6",
    slow: false,
    ttftHint: "0.7–8.8s",
  },
  // Label 「Kimi K2.6（顯示思考過程）」/ "Kimi K2.6 (show thinking)": the opt-in model that streams its reasoning.
  // Agents keep defaulting to the no-think "kimi-k2.6" (R20).
  "kimi-k2.6-thinking": {
    key: "kimi-k2.6-thinking",
    workersAiId: "@cf/moonshotai/kimi-k2.6",
    reasoningEffort: "high",
    maxTokens: 8000,
    labelKey: "agents.models.kimi-k2.6-thinking",
    slow: true,
    ttftHint: "思考 0.6–1s／正文 16–25s",
  },
  "glm-5.3": {
    key: "glm-5.3",
    workersAiId: "@cf/zai-org/glm-5.3",
    reasoningEffort: "low",
    maxTokens: 4000,
    labelKey: "agents.models.glm-5.3",
    slow: true,
    ttftHint: "1–36s",
  },
};
