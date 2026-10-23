// Regression: with the real AI SDK v6 streamText, a tool's `execute` starts before
// the `tool-call` part reaches the fullStream consumer. Subagents started from
// that tool must still nest under the tool's execute_tool span.
import * as aiNs from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { AgentEnv } from "./env";
import { runAgent, runParallel, runSubagent, type RunContext, type SubagentDef } from "./runtime";
import type { TraceEvent } from "./trace-events";
import { reduceTrace, type RunTrace } from "./trace-tree";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const finish = (unified: string) => ({ type: "finish", finishReason: { unified, raw: unified }, usage });
const textChunks = (t: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: t },
  { type: "text-end", id: "1" },
  finish("stop"),
];
/** Mock model whose n-th doStream call (one per step) streams `steps[n]` (last entry repeats). */
const mockModel = (...steps: unknown[][]) => {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ stream: aiNs.simulateReadableStream({ chunks: steps[Math.min(call++, steps.length - 1)]! }) }) as any,
  });
};
const toolCallChunks = (toolCallId: string, toolName: string) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId, toolName, input: "{}" },
  finish("tool-calls"),
];

describe("tool span ordering with real streamText", () => {
  it("execute_tool span-start precedes its subagents and the tree has a single root", async () => {
    const ai = {
      ...aiNs,
      streamText: (args: Parameters<typeof aiNs.streamText>[0]) => {
        const isMain = args.experimental_telemetry?.functionId === "main";
        const model = isMain ? mockModel(toolCallChunks("call-1", "fan"), textChunks("done")) : mockModel(textChunks("sub-out"));
        return aiNs.streamText({ ...args, model });
      },
    } as unknown as typeof import("ai");

    const events: TraceEvent[] = [];
    const ctx: RunContext = {
      env: {} as AgentEnv,
      ai,
      emit: (e) => events.push(e),
      now: () => events.length,
      conversationId: "c",
      storeContent: false,
      signal: new AbortController().signal,
    };
    const sub: SubagentDef<number> = {
      functionId: "sub",
      model: "glm-5.3-flash",
      system: "",
      maxSteps: 1,
      tools: () => ({}),
      prompt: () => "x",
    };

    await runAgent(
      {
        id: "cloudflare-docs",
        functionId: "main",
        defaultModel: "glm-5.3-flash",
        maxSteps: 3,
        system: () => "",
        tools: (c) => ({
          fan: aiNs.tool({
            inputSchema: aiNs.jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
            execute: async (_input, options) => {
              const r = await runParallel(
                [0, 1].map((i) => ({ name: `s${i}`, run: () => runSubagent(sub, i, c, options.toolCallId, i) })),
              );
              return r.ok.length;
            },
          }),
        }),
      },
      [{ role: "user", content: "hi" }],
      "glm-5.3-flash",
      ctx,
    );

    const runId = (events[0] as Extract<TraceEvent, { type: "run-start" }>).runId;
    const starts = events.filter((e) => e.type === "span-start") as Extract<TraceEvent, { type: "span-start" }>[];
    const idx = (id: string) => starts.findIndex((s) => s.id === id);

    // (a) the tool span starts before the subagents it parents, exactly once
    expect(starts.filter((s) => s.id === "call-1")).toHaveLength(1);
    expect(starts[idx("call-1")]).toMatchObject({ parentId: runId, kind: "execute_tool", name: "fan" });
    expect(idx("call-1")).toBeGreaterThanOrEqual(0);
    expect(idx("call-1")).toBeLessThan(idx("call-1:sub:0"));
    expect(idx("call-1")).toBeLessThan(idx("call-1:sub:1"));
    expect(events.filter((e) => e.type === "span-end" && e.id === "call-1")).toHaveLength(1);
    expect(events.find((e) => e.type === "span-end" && e.id === "call-1")).toMatchObject({ status: "ok" });

    // (b) the reduced tree has a single root and the subagents sit under the tool span
    let trace: RunTrace | null = null;
    for (const e of events) trace = reduceTrace(trace, e);
    expect(trace!.rootIds).toEqual([runId]);
    expect(trace!.spans["call-1"]!.children.map((c) => c.id).sort()).toEqual(["call-1:sub:0", "call-1:sub:1"]);
    expect(trace!.status).toBe("ok");
    expect(trace!.text).toBe("done");
  });

  it("a tool whose execute throws gets exactly one span-end (error)", async () => {
    const ai = {
      ...aiNs,
      streamText: (args: Parameters<typeof aiNs.streamText>[0]) =>
        aiNs.streamText({ ...args, model: mockModel(toolCallChunks("call-x", "boom"), textChunks("ok")) }),
    } as unknown as typeof import("ai");
    const events: TraceEvent[] = [];
    const ctx: RunContext = {
      env: {} as AgentEnv,
      ai,
      emit: (e) => events.push(e),
      now: () => events.length,
      conversationId: "c",
      storeContent: false,
      signal: new AbortController().signal,
    };
    await runAgent(
      {
        id: "cloudflare-docs",
        functionId: "main",
        defaultModel: "glm-5.3-flash",
        maxSteps: 3,
        system: () => "",
        tools: () => ({
          boom: aiNs.tool({
            inputSchema: aiNs.jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
            execute: async (): Promise<string> => {
              throw new Error("tool exploded");
            },
          }),
        }),
      },
      [{ role: "user", content: "hi" }],
      "glm-5.3-flash",
      ctx,
    );
    expect(events.filter((e) => e.type === "span-start" && e.id === "call-x")).toHaveLength(1);
    const ends = events.filter((e) => e.type === "span-end" && e.id === "call-x");
    expect(ends).toEqual([expect.objectContaining({ status: "error", detail: { error: "tool exploded" } })]);
  });
});
