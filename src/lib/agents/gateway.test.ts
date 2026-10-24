import { describe, it, expect } from "vitest";
import { AGENT_MODELS } from "./models";
import { injectBodyParams } from "./gateway";

describe("injectBodyParams", () => {
  it("adds reasoning_effort to a JSON body", () => {
    const out = injectBodyParams(
      { method: "POST", body: JSON.stringify({ model: "m", stream: true }) },
      { reasoning_effort: "none" },
    );
    expect(JSON.parse(out!.body as string)).toEqual({ model: "m", stream: true, reasoning_effort: "none" });
  });
  it("leaves non-JSON or missing bodies untouched", () => {
    expect(injectBodyParams(undefined, { reasoning_effort: "low" })).toBeUndefined();
    const init = { body: "not json" };
    expect(injectBodyParams(init, { reasoning_effort: "low" })).toBe(init);
  });
});

describe("AGENT_MODELS", () => {
  it("pins the measured settings", () => {
    expect(AGENT_MODELS["glm-5.3-flash"]).toMatchObject({ workersAiId: "@cf/zai-org/glm-5.3-flash", reasoningEffort: "low", iconUrl: "/zai.svg" });
    expect(AGENT_MODELS["kimi-k2.6"]).toMatchObject({ workersAiId: "@cf/moonshotai/kimi-k2.6", reasoningEffort: "none", iconUrl: "/moonshotai.svg" });
    expect(AGENT_MODELS["kimi-k2.6-thinking"]).toMatchObject({ workersAiId: "@cf/moonshotai/kimi-k2.6", reasoningEffort: "high", iconUrl: "/moonshotai.svg" });
    expect(AGENT_MODELS["glm-5.3"]).toMatchObject({ workersAiId: "@cf/zai-org/glm-5.3", reasoningEffort: "low", iconUrl: "/zai.svg" });
    for (const m of Object.values(AGENT_MODELS)) expect(m.maxTokens).toBeGreaterThanOrEqual(2000);
  });
});
