// runAgent-level check of the dispatcher flow: no root planning step, the root makes exactly ONE model call, and
// the trace is root → dispatch / prefetch / brief → analyst invoke_agent spans.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as aiNs from "ai";
import type { TextStreamPart, ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEnv } from "../env";
import { runAgent, type RunContext } from "../runtime";
import type { TraceEvent } from "../trace-events";
import { threatIntelAgent } from "./threat-intel";

type Part = TextStreamPart<ToolSet>;
const p = (o: Record<string, unknown>) => o as unknown as Part;

function textStream(text: string): AsyncIterable<Part> {
  return {
    async *[Symbol.asyncIterator]() {
      yield p({ type: "start-step", request: {}, warnings: [] });
      yield p({ type: "text-delta", id: "t", text });
      yield p({ type: "finish-step", usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" });
    },
  };
}

const radarJson = JSON.parse(
  readFileSync(join(__dirname, "..", "tools", "__fixtures__", "radar", "attackers_of.json"), "utf8"),
) as unknown;

afterEach(() => vi.restoreAllMocks());

describe("threat-intel runtime (dispatcher)", () => {
  it("root makes exactly one model call (no tools) after dispatch → brief → analysts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(radarJson));
    const calls: Array<{ functionId: string; system: string; tools: unknown }> = [];
    const ai = {
      ...aiNs,
      streamText: (args: { experimental_telemetry: { functionId: string }; system: string; tools: unknown }) => {
        const functionId = args.experimental_telemetry.functionId;
        calls.push({ functionId, system: args.system, tools: args.tools });
        return { fullStream: textStream(functionId === "threat-intel-agent" ? "答案" : `${functionId} finding`) };
      },
    } as unknown as typeof import("ai");
    const events: TraceEvent[] = [];
    let t = 0;
    const ctx: RunContext = {
      env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t", AI_GATEWAY_ID: "g", KV: { get: async () => null, put: async () => {} } } as unknown as AgentEnv,
      ai,
      emit: (e) => events.push(e),
      now: () => t++,
      conversationId: "c",
      storeContent: false,
      signal: new AbortController().signal,
    };
    await runAgent(threatIntelAgent, [{ role: "user", content: "誰在攻擊台灣？機器人流量多少？" }], "glm-5.3-flash", ctx);

    const rootCalls = calls.filter((c) => c.functionId === "threat-intel-agent");
    expect(rootCalls).toHaveLength(1);
    expect(Object.keys(rootCalls[0]!.tools as object)).toEqual([]);
    expect(rootCalls[0]!.system).toContain("### attack-analyst\nattack-analyst finding");
    expect(rootCalls[0]!.system).toContain("### bot-analyst\nbot-analyst finding");
    // the analysts ran before the root's only call
    expect(calls.map((c) => c.functionId).sort()).toEqual(["attack-analyst", "bot-analyst", "threat-intel-agent"]);
    expect(calls.at(-1)!.functionId).toBe("threat-intel-agent");

    const runId = (events[0] as { runId: string }).runId;
    const starts = events.filter((e): e is Extract<TraceEvent, { type: "span-start" }> => e.type === "span-start");
    const byId = new Map(starts.map((s) => [s.id, s]));
    expect(byId.get(`${runId}/dispatch`)).toMatchObject({ parentId: runId, kind: "execute_tool", name: "dispatch" });
    expect(byId.get(`${runId}/brief`)).toMatchObject({ parentId: runId, kind: "execute_tool", name: "brief" });
    expect(byId.get(`${runId}/prefetch`)).toMatchObject({ parentId: runId, kind: "execute_tool", name: "attackers_of" });
    const analysts = starts.filter((s) => s.kind === "invoke_agent" && s.id !== runId);
    expect(analysts.map((s) => [s.name, s.parentId])).toEqual([
      ["attack-analyst", `${runId}/brief`],
      ["bot-analyst", `${runId}/brief`],
    ]);
    const rootChats = starts.filter((s) => s.kind === "chat" && s.parentId === runId);
    expect(rootChats).toHaveLength(1);
    // order: dispatch first, the root chat span only after brief ended
    const idx = (pred: (e: TraceEvent) => boolean) => events.findIndex(pred);
    expect(idx((e) => e.type === "span-start" && e.id === `${runId}/dispatch`)).toBeLessThan(
      idx((e) => e.type === "span-start" && e.id === `${runId}/brief`),
    );
    expect(idx((e) => e.type === "span-end" && e.id === `${runId}/brief`)).toBeLessThan(
      idx((e) => e.type === "span-start" && e.id === rootChats[0]!.id),
    );
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "ok" });
  });
});
