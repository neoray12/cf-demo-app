// Runtime primitives added for the speed work: markup stripping, no-think subagents, SubagentDef.prepare,
// runTracedTool, AgentDef.prefetch, the subagent final-step note and hedge details on chat spans.
import * as aiNs from "ai";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEnv } from "./env";
import { noThink } from "./models";
import {
  SUBAGENT_FINAL_STEP_NOTE,
  lastUserText,
  pipeStepStream,
  runAgent,
  runSubagent,
  runTracedTool,
  type AgentDef,
  type RunContext,
  type SubagentDef,
} from "./runtime";
import type { TraceEvent } from "./trace-events";

type Part = TextStreamPart<ToolSet>;
const p = (o: Record<string, unknown>) => o as unknown as Part;
type Step = { at: number; part: Part };

function fakeStream(clock: { t: number }, steps: Step[]): AsyncIterable<Part> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const s of steps) {
        clock.t = s.at;
        yield s.part;
      }
    },
  };
}

const env = { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t", AI_GATEWAY_ID: "g", KV: {} } as unknown as AgentEnv;

function makeCtx(overrides: Partial<RunContext> = {}) {
  const events: TraceEvent[] = [];
  const clock = { t: 0 };
  const ctx: RunContext = {
    env,
    ai: aiNs,
    emit: (e) => events.push(e),
    now: () => clock.t,
    conversationId: "conv-1",
    storeContent: true,
    signal: new AbortController().signal,
    ...overrides,
  };
  return { ctx, events, clock };
}

function fakeAI(streams: Array<(clock: { t: number }) => AsyncIterable<Part>>, clock: { t: number }) {
  const calls: Record<string, unknown>[] = [];
  const ai = {
    ...aiNs,
    streamText: (args: Record<string, unknown>) => {
      calls.push(args);
      const make = streams.shift();
      if (!make) throw new Error("no more fake streams");
      return { fullStream: make(clock) };
    },
  } as unknown as typeof import("ai");
  return { ai, calls };
}

const oneStep = (text: string, at = 1) => (c: { t: number }) =>
  fakeStream(c, [
    { at, part: p({ type: "start-step", request: {}, warnings: [] }) },
    { at: at + 1, part: p({ type: "text-delta", id: "t", text }) },
    { at: at + 2, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
  ]);

afterEach(() => {
  delete (globalThis as { __CF_WORKERS__?: unknown }).__CF_WORKERS__;
  vi.restoreAllMocks();
});

describe("leaked tool-call markup is stripped from model text", () => {
  const LEAK =
    '<|tool_calls_section_begin|><|tool_call_begin|>functions.search_docs:4<|tool_call_argument_begin|>{"query": "x"}<|tool_call_end|><|tool_calls_section_end|>';

  it("deltas, text and finalText never contain the markup, even split across chunks", async () => {
    const { ctx, events, clock } = makeCtx();
    const raw = `Finding: KV is fast.${LEAK} Done <`;
    const pieces: Step[] = [];
    let at = 1;
    pieces.push({ at: at++, part: p({ type: "start-step", request: {}, warnings: [] }) });
    for (let i = 0; i < raw.length; i += 3) pieces.push({ at: at++, part: p({ type: "text-delta", id: "t", text: raw.slice(i, i + 3) }) });
    pieces.push({ at: at++, part: p({ type: "reasoning-delta", id: "r", text: "think<|tool_call_begin|>functions.a:0" }) });
    pieces.push({ at: at++, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) });
    const res = await pipeStepStream(fakeStream(clock, pieces), ctx, { parentSpanId: "P", modelLabel: "kimi-k2.6", forwardText: true });
    expect(res.text).toBe("Finding: KV is fast. Done <");
    expect(res.finalText).toBe("Finding: KV is fast. Done <");
    const deltas = events.filter((e) => e.type === "text-delta" || e.type === "reasoning-delta") as Array<{ type: string; text: string }>;
    expect(deltas.map((d) => d.text).join("")).not.toContain("<|");
    expect(deltas.filter((d) => d.type === "reasoning-delta").map((d) => d.text).join("")).toBe("think");
    // the held-back trailing "<" is flushed before the chat span ends
    const lastDelta = events.findLastIndex((e) => e.type === "text-delta");
    const chatEnd = events.findIndex((e) => e.type === "span-end" && e.id === "P:chat:0");
    expect(lastDelta).toBeLessThan(chatEnd);
  });

  it("a subagent's output (its finding) is returned without markup", async () => {
    const { ctx, clock } = makeCtx();
    const { ai } = fakeAI([oneStep(`Finding.${LEAK}`)], clock);
    const def: SubagentDef<string> = { functionId: "docs-researcher", model: "kimi-k2.6", system: "s", maxSteps: 1, tools: () => ({}), prompt: (s) => s };
    expect(await runSubagent(def, "q", { ...ctx, ai }, "P", 0)).toEqual({ text: "Finding." });
  });
});

describe("subagents never think", () => {
  it("noThink maps the thinking models to their no-think variants and leaves the rest", () => {
    expect(noThink("kimi-k2.6-thinking")).toBe("kimi-k2.6");
    expect(noThink("glm-5.3")).toBe("glm-5.3-flash");
    expect(noThink("kimi-k2.6")).toBe("kimi-k2.6");
    expect(noThink("glm-5.3-flash")).toBe("glm-5.3-flash");
  });

  it.each([
    ["kimi-k2.6-thinking", "kimi-k2.6"],
    ["glm-5.3", "glm-5.3-flash"],
    ["kimi-k2.6", "kimi-k2.6"],
  ] as const)("menu %s → root uses it, subagent uses %s", async (menu, sub) => {
    const { ctx, events, clock } = makeCtx();
    const subDef: SubagentDef<string> = { functionId: "r", model: "kimi-k2.6", system: "s", maxSteps: 1, tools: () => ({}), prompt: (s) => s };
    const def: AgentDef = {
      id: "cloudflare-docs",
      functionId: "docs-agent",
      defaultModel: "kimi-k2.6",
      maxSteps: 1,
      system: () => "sys",
      tools: () => ({}),
      after: async (c, r) => void (await runSubagent(subDef, "x", c, r.rootSpanId, 0)),
    };
    const { ai, calls } = fakeAI([oneStep("root"), oneStep("sub", 10)], clock);
    await runAgent(def, [{ role: "user", content: "hi" }], menu, { ...ctx, ai });
    const models = calls.map((c) => (c.experimental_telemetry as { metadata: { model: string } }).metadata.model);
    expect(models).toEqual([menu, sub]);
    const chatNames = events.filter((e) => e.type === "span-start" && e.kind === "chat").map((e) => (e as { name: string }).name);
    expect(chatNames).toEqual([menu, sub]);
  });
});

describe("SubagentDef.prepare", () => {
  it("runs inside the subagent span before its model call; its text is appended to the prompt", async () => {
    const { ctx, events, clock } = makeCtx();
    const seen: string[] = [];
    const def: SubagentDef<{ q: string }> = {
      functionId: "docs-researcher",
      model: "kimi-k2.6",
      system: "s",
      maxSteps: 1,
      tools: () => ({}),
      prompt: ({ q }) => `Sub-question: ${q}`,
      prepare: async ({ q }, c, spanId) => {
        seen.push(spanId);
        return runTracedTool(c, spanId, "search_docs", { query: q }, async () => "RESULTS", { callId: "search" });
      },
    };
    const { ai, calls } = fakeAI([oneStep("finding", 5)], clock);
    await runSubagent(def, { q: "R2" }, { ...ctx, ai }, "T", 1);
    const id = "T:docs-researcher:1";
    expect(seen).toEqual([id]);
    expect(calls[0]!.prompt).toBe("Sub-question: R2\n\nRESULTS");
    const starts = events.filter((e) => e.type === "span-start") as Array<{ id: string; parentId?: string; kind: string }>;
    expect(starts.map((s) => [s.id, s.parentId, s.kind])).toEqual([
      [id, "T", "invoke_agent"],
      [`${id}/search`, id, "execute_tool"],
      [`${id}:chat:0`, id, "chat"],
    ]);
    // the search span ends before the model call starts
    const searchEnd = events.findIndex((e) => e.type === "span-end" && e.id === `${id}/search`);
    const chatStart = events.findIndex((e) => e.type === "span-start" && e.id === `${id}:chat:0`);
    expect(searchEnd).toBeLessThan(chatStart);
  });

  it("a failing prepare fails the attempt and is retried once (R32)", async () => {
    const { ctx, events, clock } = makeCtx();
    let n = 0;
    const def: SubagentDef<string> = {
      functionId: "r",
      model: "kimi-k2.6",
      system: "s",
      maxSteps: 1,
      tools: () => ({}),
      prompt: (s) => s,
      prepare: async () => {
        if (n++ === 0) throw new Error("search timed out");
        return "ok";
      },
    };
    const { ai } = fakeAI([oneStep("finding")], clock);
    expect(await runSubagent(def, "q", { ...ctx, ai }, "T", 0)).toEqual({ text: "finding" });
    expect(events.find((e) => e.type === "span-end" && e.id === "T:r:0")).toMatchObject({ status: "error", detail: { error: "search timed out" } });
    expect(events.find((e) => e.type === "span-end" && e.id === "T:r:0r")).toMatchObject({ status: "ok" });
  });
});

describe("R23 for subagents: the forced final step says to write the finding now", () => {
  type Prepare = (o: { stepNumber: number; messages?: ModelMessage[] }) => Record<string, unknown>;
  it("after a tool round the last step appends the note (tools still disabled); a single-step subagent gets no note", async () => {
    const { ctx, clock } = makeCtx();
    const def: SubagentDef<string> = { functionId: "r", model: "kimi-k2.6", system: "s", maxSteps: 3, tools: () => ({}), prompt: (s) => s };
    const { ai, calls } = fakeAI([oneStep("x"), oneStep("y")], clock);
    await runSubagent(def, "q", { ...ctx, ai }, "T", 0);
    const prepare = calls[0]!.prepareStep as Prepare;
    const messages: ModelMessage[] = [{ role: "user", content: "q" }];
    expect(prepare({ stepNumber: 1, messages })).toEqual({});
    expect(prepare({ stepNumber: 2, messages })).toEqual({
      toolChoice: "none",
      activeTools: [],
      messages: [...messages, { role: "user", content: SUBAGENT_FINAL_STEP_NOTE }],
    });
    expect(SUBAGENT_FINAL_STEP_NOTE).toMatch(/Write your finding now/);

    await runSubagent({ ...def, maxSteps: 1 }, "q", { ...ctx, ai }, "T", 1);
    expect((calls[1]!.prepareStep as Prepare)({ stepNumber: 0, messages })).toEqual({ toolChoice: "none", activeTools: [] });
  });
});

describe("runTracedTool", () => {
  it("emits span-start + span-input synchronously, then span-end with input/output", async () => {
    const { ctx, events } = makeCtx();
    let release!: (v: { hits: number }) => void;
    const pending = runTracedTool(ctx, "root", "search_docs", { query: "kv" }, (id) => {
      expect(id).toBe("root/prefetch");
      return new Promise((r) => (release = r));
    }, { callId: "prefetch" });
    expect(events).toEqual([
      { type: "span-start", id: "root/prefetch", parentId: "root", kind: "execute_tool", name: "search_docs", t: 0 },
      { type: "span-input", id: "root/prefetch", input: { query: "kv" } },
    ]);
    release({ hits: 2 });
    expect(await pending).toEqual({ hits: 2 });
    expect(events[2]).toEqual({
      type: "span-end",
      id: "root/prefetch",
      t: 0,
      status: "ok",
      detail: { input: { query: "kv" }, output: { hits: 2 } },
    });
  });

  it("failed(result) marks the span as error but returns the result; a throw ends the span with the error and rethrows", async () => {
    const { ctx, events } = makeCtx();
    const r = await runTracedTool(ctx, "P", "search_docs", {}, async () => ({ error: "boom" }), {
      callId: "a",
      failed: (x) => x.error,
    });
    expect(r).toEqual({ error: "boom" });
    expect(events.at(-1)).toMatchObject({ type: "span-end", id: "P/a", status: "error", detail: { error: "boom" } });
    await expect(runTracedTool(ctx, "P", "search_docs", {}, async () => Promise.reject(new Error("timed out")), { callId: "b" })).rejects.toThrow(
      "timed out",
    );
    expect(events.at(-1)).toEqual({ type: "span-end", id: "P/b", t: 0, status: "error", detail: { error: "timed out" } });
  });

  it("also opens a Cloudflare custom span (tracing.enterSpan) with the gen_ai tool attributes", async () => {
    const attrs: Record<string, unknown> = {};
    const names: string[] = [];
    globalThis.__CF_WORKERS__ = {
      tracing: {
        enterSpan: (name: string, cb: (span: unknown) => unknown) => {
          names.push(name);
          return cb({ setAttribute: (k: string, v: unknown) => void (attrs[k] = v) });
        },
      },
    } as never;
    const { ctx } = makeCtx();
    await runTracedTool(ctx, "root", "search_docs", { query: "kv" }, async () => ({ results: ["x".repeat(9000)] }), { callId: "prefetch" });
    expect(names).toEqual(["execute_tool search_docs"]);
    expect(attrs).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search_docs",
      "gen_ai.tool.call.id": "root/prefetch",
      "gen_ai.tool.call.arguments": '{"query":"kv"}',
    });
    expect((attrs["gen_ai.tool.call.result"] as string).length).toBeLessThanOrEqual(8001);

    // storeContent off: no arguments / result
    for (const k of Object.keys(attrs)) delete attrs[k];
    await runTracedTool({ ...ctx, storeContent: false }, "root", "search_docs", { query: "kv" }, async () => 1, { callId: "c" });
    expect(attrs).not.toHaveProperty("gen_ai.tool.call.arguments");
    expect(attrs).not.toHaveProperty("gen_ai.tool.call.result");
  });

  it("falls back to startActiveSpan (and ends the span) when enterSpan is missing", async () => {
    const end = vi.fn();
    globalThis.__CF_WORKERS__ = {
      tracing: { startActiveSpan: (_n: string, cb: (span: unknown) => unknown) => cb({ setAttribute: () => {}, end }) },
    } as never;
    const { ctx } = makeCtx();
    expect(await runTracedTool(ctx, "root", "t", {}, async () => 7, { callId: "x" })).toBe(7);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("AgentDef.prefetch", () => {
  const base = (over: Partial<AgentDef>): AgentDef => ({
    id: "cloudflare-docs",
    functionId: "docs-agent",
    defaultModel: "kimi-k2.6",
    maxSteps: 1,
    system: () => "sys",
    tools: () => ({}),
    ...over,
  });

  it("background: its tool span starts right after the root span, the model call does not wait, after() gets its toolResults first", async () => {
    const { ctx, events, clock } = makeCtx();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let modelCalledBeforePrefetchDone = false;
    let prefetchDone = false;
    const after = vi.fn(async () => {});
    const def = base({
      prefetch: (c, rootSpanId, userText) =>
        runTracedTool(c, rootSpanId, "search_docs", { query: userText }, async () => {
          await gate;
          prefetchDone = true;
          return { results: [1] };
        }, { callId: "prefetch" }).then((data) => ({ data, toolResults: [{ toolName: "search_docs", output: data }] })),
      after,
      tools: (c) => {
        expect(c.prefetched).toBeInstanceOf(Promise);
        return {};
      },
    });
    const ai = {
      ...aiNs,
      streamText: () => {
        modelCalledBeforePrefetchDone = !prefetchDone;
        setTimeout(release, 5);
        return { fullStream: oneStep("answer")(clock) };
      },
    } as unknown as typeof import("ai");
    await runAgent(def, [{ role: "assistant", content: "old" }, { role: "user", content: "Workers vs Pages?" }], "kimi-k2.6", { ...ctx, ai });
    expect(modelCalledBeforePrefetchDone).toBe(true);
    const runId = (events[0] as { runId: string }).runId;
    expect(events[2]).toEqual({ type: "span-start", id: `${runId}/prefetch`, parentId: runId, kind: "execute_tool", name: "search_docs", t: 0 });
    expect(events[3]).toEqual({ type: "span-input", id: `${runId}/prefetch`, input: { query: "Workers vs Pages?" } });
    // the prefetch span ends (ok) before the root span ends
    const preEnd = events.findIndex((e) => e.type === "span-end" && e.id === `${runId}/prefetch`);
    const rootEnd = events.findIndex((e) => e.type === "span-end" && e.id === runId);
    expect(events[preEnd]).toMatchObject({ status: "ok" });
    expect(preEnd).toBeLessThan(rootEnd);
    const args = after.mock.calls[0] as unknown as [RunContext, { toolResults: unknown[] }];
    expect(args[1].toolResults).toEqual([{ toolName: "search_docs", output: { results: [1] } }]);
  });

  it("await: the first model call waits and gets the context in its system prompt", async () => {
    const { ctx, clock } = makeCtx();
    const def = base({ prefetch: async () => ({ context: "【預先檢索結果】[1] a.md" }), prefetchMode: "await" });
    const { ai, calls } = fakeAI([oneStep("answer")], clock);
    await runAgent(def, [{ role: "user", content: "q" }], "kimi-k2.6", { ...ctx, ai });
    expect(calls[0]!.system).toBe("sys\n\n【預先檢索結果】[1] a.md");
  });

  it("a failing prefetch never fails the run", async () => {
    const { ctx, events, clock } = makeCtx();
    const def = base({
      prefetch: () => {
        throw new Error("sync boom");
      },
      prefetchMode: "await",
    });
    const { ai } = fakeAI([oneStep("answer")], clock);
    await runAgent(def, [{ role: "user", content: "q" }], "kimi-k2.6", { ...ctx, ai });
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "ok" });
  });

  it("lastUserText reads string or text-part content of the last user message", () => {
    expect(lastUserText([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).toBe("a");
    expect(lastUserText([{ role: "user", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] }])).toBe("xy");
    expect(lastUserText([])).toBe("");
  });
});

describe("hedged requests show up on the chat span", () => {
  it("finish-step response headers x-agents-hedge* → chat span-end detail.hedge (only when a hedge fired)", async () => {
    const { ctx, events, clock } = makeCtx();
    const finish = (headers: Record<string, string>, at: number): Step => ({
      at,
      part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop", response: { headers } }),
    });
    await pipeStepStream(
      fakeStream(clock, [
        { at: 1, part: p({ type: "start-step", request: {}, warnings: [] }) },
        finish({ "x-agents-hedge": "b", "x-agents-hedge-fired": "1" }, 2),
        { at: 3, part: p({ type: "start-step", request: {}, warnings: [] }) },
        finish({ "x-agents-hedge": "a", "x-agents-hedge-fired": "0" }, 4),
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "kimi-k2.6", forwardText: false },
    );
    const ends = events.filter((e) => e.type === "span-end") as Array<{ id: string; detail?: unknown }>;
    expect(ends.map((e) => e.detail)).toEqual([
      { finishReason: "stop", hedge: { fired: true, winner: "b" } },
      { finishReason: "stop" },
    ]);
  });
});
