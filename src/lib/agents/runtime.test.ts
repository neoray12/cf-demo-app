import * as aiNs from "ai";
import type { TextStreamPart, ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEnv } from "./env";
import {
  FIRST_PART_IDLE_MS,
  STREAM_IDLE_MS,
  pipeStepStream,
  runAgent,
  runParallel,
  runSubagent,
  type AgentDef,
  type RunContext,
  type SubagentDef,
} from "./runtime";
import type { TraceEvent } from "./trace-events";
import { getTracedAI, recordActiveSpanException, setActiveSpanAttributes } from "./tracing";

type Part = TextStreamPart<ToolSet>;
const p = (o: Record<string, unknown>) => o as unknown as Part;

/** Shared fake clock: each scripted part sets the clock before it is yielded. */
function makeClock() {
  const clock = { t: 0 };
  return { clock, now: () => clock.t };
}

type Step = { at: number; part: Part } | { at: number; run: () => void } | { hang: true } | { sleep: number };

function fakeStream(clock: { t: number }, steps: Step[]): AsyncIterable<Part> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const s of steps) {
        if ("hang" in s) {
          await new Promise(() => {});
          return;
        }
        if ("sleep" in s) {
          await new Promise((r) => setTimeout(r, s.sleep));
          continue;
        }
        clock.t = s.at;
        if ("run" in s) {
          s.run();
          continue;
        }
        yield s.part;
      }
    },
  };
}

const env: AgentEnv = {
  CF_ACCOUNT_ID: "acct",
  CF_API_TOKEN: "tok",
  AI_GATEWAY_ID: "gw",
  KB_AI_SEARCH: "kb",
  KB_BUCKET_NAME: "bucket",
  MCP_SERVER_URLS: "",
  R2_ACCESS_KEY_ID: "",
  R2_SECRET_ACCESS_KEY: "",
  KV: {} as KVNamespace,
};

function makeCtx(overrides: Partial<RunContext> = {}) {
  const events: TraceEvent[] = [];
  const { clock, now } = makeClock();
  const ac = new AbortController();
  const ctx: RunContext = {
    env,
    ai: aiNs,
    emit: (e) => events.push(e),
    now,
    conversationId: "conv-1",
    storeContent: false,
    signal: ac.signal,
    ...overrides,
  };
  return { ctx, events, clock, ac };
}

const twoSteps = (): Step[] => [
  { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
  { at: 500, part: p({ type: "reasoning-delta", id: "r", text: "think" }) },
  { at: 800, part: p({ type: "text-delta", id: "t", text: "Hello" }) },
  { at: 900, part: p({ type: "tool-call", toolCallId: "c1", toolName: "search_docs", input: { q: "x" } }) },
  {
    at: 1000,
    part: p({ type: "tool-result", toolCallId: "c1", toolName: "search_docs", input: { q: "x" }, output: { hits: 1 } }),
  },
  { at: 1100, part: p({ type: "finish-step", usage: { inputTokens: 120, outputTokens: 30 }, finishReason: "tool-calls" }) },
  { at: 1200, part: p({ type: "start-step", request: {}, warnings: [] }) },
  { at: 1500, part: p({ type: "text-delta", id: "t", text: " world" }) },
  { at: 1600, part: p({ type: "finish-step", usage: { inputTokens: 200, outputTokens: 10 }, finishReason: "stop" }) },
];

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { __CF_WORKERS__?: unknown }).__CF_WORKERS__;
});

describe("pipeStepStream", () => {
  it("maps v6 stream parts to span / delta events in order", async () => {
    const { ctx, events, clock } = makeCtx();
    const res = await pipeStepStream(fakeStream(clock, twoSteps()), ctx, {
      parentSpanId: "P",
      modelLabel: "glm-5.3-flash",
      forwardText: true,
    });

    expect(events.map((e) => e.type)).toEqual([
      "span-start",
      "reasoning-delta",
      "text-delta",
      "span-start",
      "span-end",
      "span-end",
      "span-start",
      "text-delta",
      "span-end",
    ]);
    expect(events[0]).toEqual({ type: "span-start", id: "P:chat:0", parentId: "P", kind: "chat", name: "glm-5.3-flash", t: 0 });
    expect(events[1]).toEqual({ type: "reasoning-delta", spanId: "P:chat:0", text: "think" });
    expect(events[2]).toEqual({ type: "text-delta", spanId: "P:chat:0", text: "Hello" });
    expect(events[3]).toEqual({ type: "span-start", id: "c1", parentId: "P", kind: "execute_tool", name: "search_docs", t: 900 });
    expect(events[4]).toMatchObject({ type: "span-end", id: "c1", t: 1000, status: "ok", detail: { input: { q: "x" }, output: { hits: 1 } } });
    expect(events[5]).toMatchObject({ type: "span-end", id: "P:chat:0", t: 1100, status: "ok", ttftMs: 500, usage: { input: 120, output: 30 } });
    expect(events[6]).toMatchObject({ type: "span-start", id: "P:chat:1", parentId: "P", kind: "chat", t: 1200 });
    expect(events[7]).toEqual({ type: "text-delta", spanId: "P:chat:1", text: " world" });
    expect(events[8]).toMatchObject({ type: "span-end", id: "P:chat:1", t: 1600, status: "ok", ttftMs: 300, usage: { input: 200, output: 10 } });

    expect(res.text).toBe("Hello world");
    expect(res.firstTokenAt).toBe(500);
    expect(res.toolResults).toEqual([{ toolName: "search_docs", output: { hits: 1 } }]);
  });

  it("forwardText:false suppresses deltas but still returns text and ttft", async () => {
    const { ctx, events, clock } = makeCtx();
    const res = await pipeStepStream(fakeStream(clock, twoSteps()), ctx, {
      parentSpanId: "P",
      modelLabel: "m",
      forwardText: false,
    });
    expect(events.some((e) => e.type === "text-delta" || e.type === "reasoning-delta")).toBe(false);
    expect(res.text).toBe("Hello world");
    expect(res.firstTokenAt).toBe(500);
    expect(events.find((e) => e.type === "span-end" && e.id === "P:chat:0")).toMatchObject({ ttftMs: 500 });
  });

  it("tool-error closes the tool span with status error and a string message", async () => {
    const { ctx, events, clock } = makeCtx();
    await pipeStepStream(
      fakeStream(clock, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 10, part: p({ type: "tool-call", toolCallId: "c9", toolName: "radar", input: {} }) },
        { at: 20, part: p({ type: "tool-error", toolCallId: "c9", toolName: "radar", input: {}, error: new Error("upstream 500") }) },
        { at: 30, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    const end = events.find((e) => e.type === "span-end" && e.id === "c9");
    expect(end).toEqual({ type: "span-end", id: "c9", t: 20, status: "error", detail: { error: "upstream 500" } });
    expect(() => JSON.stringify(events)).not.toThrow();
  });

  it("truncates large tool output in span detail", async () => {
    const { ctx, events, clock } = makeCtx();
    const big = "x".repeat(5000);
    await pipeStepStream(
      fakeStream(clock, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 10, part: p({ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }) },
        { at: 20, part: p({ type: "tool-result", toolCallId: "c1", toolName: "read", input: {}, output: big }) },
        { at: 30, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    const end = events.find((e) => e.type === "span-end" && e.id === "c1") as Extract<TraceEvent, { type: "span-end" }>;
    expect(JSON.stringify(end.detail).length).toBeLessThan(2200);
  });

  it("abort mid-stream closes every open span with 'aborted' and rejects AbortError", async () => {
    const { ctx, events, clock, ac } = makeCtx();
    const promise = pipeStepStream(
      fakeStream(clock, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 10, part: p({ type: "tool-call", toolCallId: "c1", toolName: "research", input: {} }) },
        { at: 50, run: () => ac.abort() },
        { hang: true },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });

    const starts = events.filter((e) => e.type === "span-start").map((e) => (e as { id: string }).id);
    const ends = events.filter((e) => e.type === "span-end") as Extract<TraceEvent, { type: "span-end" }>[];
    expect(new Set(ends.map((e) => e.id))).toEqual(new Set(starts));
    for (const e of ends) {
      expect(e.status).toBe("error");
      expect(e.detail).toEqual({ error: "aborted" });
      expect(e.t).toBe(50);
    }
  });

  it("stream 'error' part closes open spans and rejects with the message", async () => {
    const { ctx, events, clock } = makeCtx();
    const promise = pipeStepStream(
      fakeStream(clock, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 5, part: p({ type: "error", error: new Error("gateway 7031") }) },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    await expect(promise).rejects.toThrow("gateway 7031");
    expect(events.at(-1)).toEqual({ type: "span-end", id: "P:chat:0", t: 5, status: "error", detail: { error: "gateway 7031" } });
  });

  it("idle for 60 s takes the abort cleanup path with 'idle timeout'", async () => {
    vi.useFakeTimers();
    const { ctx, events, clock } = makeCtx();
    const promise = pipeStepStream(
      fakeStream(clock, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 10, part: p({ type: "text-delta", id: "t", text: "hi" }) },
        { hang: true },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    const settled = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(events.some((e) => e.type === "span-end")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    const err = (await settled) as Error;
    expect(err.message).toBe("idle timeout");
    expect(events.at(-1)).toMatchObject({ type: "span-end", id: "P:chat:0", status: "error", detail: { error: "idle timeout" } });
  });
});

describe("pipeStepStream idle windows", () => {
  const run = (steps: Step[]) => {
    const { ctx, events, clock } = makeCtx();
    const promise = pipeStepStream(fakeStream(clock, steps), ctx, { parentSpanId: "P", modelLabel: "m", forwardText: true });
    const settled = promise.then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, e }),
    );
    return { events, settled };
  };
  const startStep = { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) };
  const finish = { at: 0, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };

  it("exports the windows", () => {
    expect(STREAM_IDLE_MS).toBe(60_000);
    expect(FIRST_PART_IDLE_MS).toBe(150_000);
  });

  it("does not time out while a tool executes (tool-call → 70 s → tool-result)", async () => {
    vi.useFakeTimers();
    const { events, settled } = run([
      startStep,
      { at: 0, part: p({ type: "text-delta", id: "t", text: "a" }) },
      { at: 0, part: p({ type: "tool-call", toolCallId: "c1", toolName: "fan", input: {} }) },
      { sleep: 70_000 },
      { at: 0, part: p({ type: "tool-result", toolCallId: "c1", toolName: "fan", input: {}, output: "ok" }) },
      finish,
    ]);
    await vi.advanceTimersByTimeAsync(70_000);
    const r = await settled;
    expect(r.ok).toBe(true);
    expect(events.find((e) => e.type === "span-end" && e.id === "c1")).toMatchObject({ status: "ok" });
  });

  it("re-arms the 60 s window after the tool finishes", async () => {
    vi.useFakeTimers();
    const { settled } = run([
      startStep,
      { at: 0, part: p({ type: "text-delta", id: "t", text: "a" }) },
      { at: 0, part: p({ type: "tool-call", toolCallId: "c1", toolName: "fan", input: {} }) },
      { sleep: 70_000 },
      { at: 0, part: p({ type: "tool-error", toolCallId: "c1", toolName: "fan", input: {}, error: "x" }) },
      { hang: true },
    ]);
    await vi.advanceTimersByTimeAsync(70_000 + STREAM_IDLE_MS + 1);
    const r = await settled;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.e.message).toBe("idle timeout");
  });

  it("allows 100 s between start-step and the step's first part", async () => {
    vi.useFakeTimers();
    const { settled } = run([startStep, { sleep: 100_000 }, { at: 0, part: p({ type: "text-delta", id: "t", text: "late" }) }, finish]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect((await settled).ok).toBe(true);
  });

  it("times out after 150 s with no first part", async () => {
    vi.useFakeTimers();
    const { events, settled } = run([startStep, { hang: true }]);
    await vi.advanceTimersByTimeAsync(FIRST_PART_IDLE_MS - 1_000);
    expect(events.some((e) => e.type === "span-end")).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await settled;
    expect(!r.ok && r.e.message).toBe("idle timeout");
  });

  it("times out after 61 s of silence following a text-delta", async () => {
    vi.useFakeTimers();
    const { events, settled } = run([
      startStep,
      { at: 0, part: p({ type: "text-delta", id: "t", text: "a" }) },
      { sleep: 61_000 },
      { at: 0, part: p({ type: "text-delta", id: "t", text: "b" }) },
      finish,
    ]);
    await vi.advanceTimersByTimeAsync(61_000);
    const r = await settled;
    expect(!r.ok && r.e.message).toBe("idle timeout");
    expect(events.at(-1)).toMatchObject({ type: "span-end", id: "P:chat:0", status: "error", detail: { error: "idle timeout" } });
  });
});

describe("runParallel", () => {
  it("collects successes and failures without throwing", async () => {
    const ok = (name: string) => ({ name, run: async () => name.toUpperCase() });
    const fail = (name: string, msg: string) => ({
      name,
      run: async (): Promise<string> => {
        throw new Error(msg);
      },
    });
    const res = await runParallel([ok("a"), fail("b", "boom"), ok("c")]);
    expect(res.ok).toEqual([
      { name: "a", value: "A" },
      { name: "c", value: "C" },
    ]);
    expect(res.failed).toEqual([{ name: "b", error: "boom" }]);
  });

  it("runs tasks concurrently", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const task = (name: string) => ({
      name,
      run: async () => {
        started.push(name);
        await gate;
        return name;
      },
    });
    const pending = runParallel([task("a"), task("b")]);
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    release();
    expect((await pending).ok).toHaveLength(2);
  });
});

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

describe("runSubagent", () => {
  const def: SubagentDef<{ q: string }> = {
    functionId: "docs-researcher",
    model: "glm-5.3-flash",
    system: "You research.",
    maxSteps: 3,
    tools: () => ({}),
    prompt: (i) => `Research: ${i.q}`,
  };

  it("emits a nested invoke_agent span and does not forward text", async () => {
    const { ctx, events, clock } = makeCtx();
    const { ai, calls } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 100, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 150, part: p({ type: "text-delta", id: "t", text: "finding" }) },
            { at: 200, part: p({ type: "finish-step", usage: { inputTokens: 5, outputTokens: 7 }, finishReason: "stop" }) },
          ]),
      ],
      clock,
    );
    clock.t = 90;
    const res = await runSubagent(def, { q: "R2" }, { ...ctx, ai }, "call-1", 2);
    expect(res).toEqual({ text: "finding" });

    const id = "call-1:docs-researcher:2";
    expect(events[0]).toEqual({ type: "span-start", id, parentId: "call-1", kind: "invoke_agent", name: "docs-researcher", t: 90 });
    expect(events[1]).toMatchObject({ type: "span-start", id: `${id}:chat:0`, parentId: id, kind: "chat" });
    expect(events.at(-1)).toEqual({ type: "span-end", id, t: 200, status: "ok", detail: { output: "finding" } });
    expect(events.some((e) => e.type === "text-delta")).toBe(false);

    const args = calls[0]!;
    expect(args.prompt).toBe("Research: R2");
    expect(args.system).toBe("You research.");
    expect(args.maxOutputTokens).toBe(4000);
    // runs on a child signal linked to ctx.signal
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
    expect(args.abortSignal).not.toBe(ctx.signal);
    expect((args.abortSignal as AbortSignal).aborted).toBe(false);
    expect(args.experimental_telemetry).toEqual({
      isEnabled: true,
      functionId: "docs-researcher",
      metadata: { agentId: "docs-researcher-demo", conversationId: "conv-1" },
    });
    expect(args.stopWhen).toBeTypeOf("function");
  });

  it("uses toDetail when provided", async () => {
    const { ctx, events, clock } = makeCtx();
    const { ai } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 1, part: p({ type: "text-delta", id: "t", text: '{"n":3}' }) },
            { at: 2, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
          ]),
      ],
      clock,
    );
    await runSubagent({ ...def, toDetail: (t) => ({ parsed: JSON.parse(t) }) }, { q: "x" }, { ...ctx, ai }, "P", 0);
    expect(events.at(-1)).toMatchObject({ type: "span-end", status: "ok", detail: { parsed: { n: 3 } } });
  });

  it("closes its span with an error and rethrows", async () => {
    const { ctx, events, clock } = makeCtx();
    const { ai } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 3, part: p({ type: "error", error: "model overloaded" }) },
          ]),
      ],
      clock,
    );
    await expect(runSubagent(def, { q: "x" }, { ...ctx, ai }, "P", 1)).rejects.toThrow("model overloaded");
    expect(events.at(-1)).toEqual({
      type: "span-end",
      id: "P:docs-researcher:1",
      t: 3,
      status: "error",
      detail: { error: "model overloaded" },
    });
  });
});

describe("runAgent", () => {
  const baseDef = (over: Partial<AgentDef> = {}): AgentDef => ({
    id: "cloudflare-docs",
    functionId: "docs-agent",
    defaultModel: "glm-5.3-flash",
    maxSteps: 5,
    system: () => "sys",
    tools: () => ({}),
    ...over,
  });

  it("emits run-start, root span, chat spans, root end and run-end with ttft + summed usage", async () => {
    const { ctx, events, clock } = makeCtx();
    clock.t = 0;
    const { ai, calls } = fakeAI([(c) => fakeStream(c, twoSteps().map((s) => ("at" in s ? { ...s, at: s.at + 100 } : s)))], clock);
    const after = vi.fn(async () => {});
    await runAgent(baseDef({ after }), [{ role: "user", content: "hi" }], "kimi-k2.6", { ...ctx, ai });

    const runStart = events[0] as Extract<TraceEvent, { type: "run-start" }>;
    expect(runStart).toMatchObject({ type: "run-start", agent: "cloudflare-docs", model: "kimi-k2.6", t: 0 });
    const runId = runStart.runId;
    expect(runId).toBeTruthy();
    expect(events[1]).toEqual({ type: "span-start", id: runId, kind: "invoke_agent", name: "docs-agent", t: 0 });
    expect(events[2]).toMatchObject({ type: "span-start", id: `${runId}:chat:0`, parentId: runId, kind: "chat" });

    expect(events.at(-2)).toMatchObject({ type: "span-end", id: runId, status: "ok", t: 1700 });
    expect(events.at(-1)).toEqual({
      type: "run-end",
      t: 1700,
      totalMs: 1700,
      ttftMs: 600,
      usage: { input: 320, output: 40 },
      status: "ok",
    });

    expect(after).toHaveBeenCalledTimes(1);
    const afterArgs = after.mock.calls[0] as unknown as [RunContext, { text: string; rootSpanId: string; toolResults: unknown[] }];
    expect(afterArgs[1]).toEqual({ text: "Hello world", rootSpanId: runId, toolResults: [{ toolName: "search_docs", output: { hits: 1 } }] });

    const args = calls[0]!;
    expect(args.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(args.system).toBe("sys");
    expect(args.maxOutputTokens).toBe(4000);
    expect(args.experimental_telemetry).toEqual({
      isEnabled: true,
      functionId: "docs-agent",
      metadata: { agentId: "docs-agent-demo", conversationId: "conv-1" },
    });
  });

  it("includes subagent chat usage in run-end usage", async () => {
    const { ctx, events, clock } = makeCtx();
    const sub: SubagentDef<string> = {
      functionId: "r",
      model: "glm-5.3-flash",
      system: "s",
      maxSteps: 1,
      tools: () => ({}),
      prompt: (s) => s,
    };
    const subStream = (c: { t: number }) =>
      fakeStream(c, [
        { at: 20, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 30, part: p({ type: "finish-step", usage: { inputTokens: 1000, outputTokens: 1 }, finishReason: "stop" }) },
      ]);
    const { ai } = fakeAI(
      [
        (c) => ({
          async *[Symbol.asyncIterator]() {
            c.t = 10;
            yield p({ type: "start-step", request: {}, warnings: [] });
            // simulate a tool that runs a subagent using the ctx handed to tools()
            await runSubagent(sub, "q", toolCtx!, "c1", 0);
            c.t = 40;
            yield p({ type: "text-delta", id: "t", text: "done" });
            yield p({ type: "finish-step", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "stop" });
          },
        }),
        subStream,
      ],
      clock,
    );
    let toolCtx: RunContext | undefined;
    await runAgent(
      baseDef({
        tools: (c) => {
          toolCtx = c;
          return {};
        },
      }),
      [{ role: "user", content: "hi" }],
      "glm-5.3-flash",
      { ...ctx, ai },
    );
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "ok", usage: { input: 1010, output: 3 }, ttftMs: 40 });
  });

  it("reports run-end status error (with ttftMs/usage) when the stream fails", async () => {
    const { ctx, events, clock } = makeCtx();
    const { ai } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 7, part: p({ type: "error", error: new Error("bad gateway") }) },
          ]),
      ],
      clock,
    );
    await expect(runAgent(baseDef(), [{ role: "user", content: "hi" }], "glm-5.3-flash", { ...ctx, ai })).resolves.toBeUndefined();
    const runId = (events[0] as Extract<TraceEvent, { type: "run-start" }>).runId;
    expect(events.at(-2)).toEqual({ type: "span-end", id: runId, t: 7, status: "error", detail: { error: "bad gateway" } });
    expect(events.at(-1)).toEqual({
      type: "run-end",
      t: 7,
      totalMs: 7,
      ttftMs: 0,
      usage: { input: 0, output: 0 },
      status: "error",
      error: "bad gateway",
    });
  });

  it("reports run-end status aborted when the signal fires", async () => {
    const { ctx, events, clock, ac } = makeCtx();
    const { ai } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 4, run: () => ac.abort() },
            { hang: true },
          ]),
      ],
      clock,
    );
    await runAgent(baseDef(), [{ role: "user", content: "hi" }], "glm-5.3-flash", { ...ctx, ai });
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "aborted", ttftMs: 0, usage: { input: 0, output: 0 } });
    const ends = events.filter((e) => e.type === "span-end");
    const starts = events.filter((e) => e.type === "span-start");
    expect(ends).toHaveLength(starts.length);
  });

  it("reports an error when def.after throws", async () => {
    const { ctx, events, clock } = makeCtx();
    const { ai } = fakeAI([(c) => fakeStream(c, twoSteps())], clock);
    await runAgent(
      baseDef({
        after: async () => {
          throw new Error("kb write failed");
        },
      }),
      [{ role: "user", content: "hi" }],
      "glm-5.3-flash",
      { ...ctx, ai },
    );
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "error", error: "kb write failed", ttftMs: 500 });
  });
});

describe("run cancellation and span ordering", () => {
  const sub: SubagentDef<number> = {
    functionId: "sub",
    model: "glm-5.3-flash",
    system: "",
    maxSteps: 1,
    tools: () => ({}),
    prompt: () => "x",
  };
  const def = (tools: AgentDef["tools"]): AgentDef => ({
    id: "cloudflare-docs",
    functionId: "main",
    defaultModel: "glm-5.3-flash",
    maxSteps: 2,
    system: () => "",
    tools,
  });

  /** Asserts: run-end is last; every started span ends exactly once before it; children end before parents. */
  function expectWellFormed(events: TraceEvent[]) {
    expect(events.at(-1)?.type).toBe("run-end");
    expect(events.filter((e) => e.type === "run-end")).toHaveLength(1);
    const starts = events.filter((e) => e.type === "span-start") as Extract<TraceEvent, { type: "span-start" }>[];
    const endIndex = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.type === "span-end") {
        expect(endIndex.has(e.id)).toBe(false);
        endIndex.set(e.id, i);
      }
    });
    for (const s of starts) {
      expect(endIndex.has(s.id)).toBe(true);
      if (s.parentId) expect(endIndex.get(s.id)!).toBeLessThan(endIndex.get(s.parentId)!);
    }
  }

  it("abort with a running subagent: all span-ends precede run-end, children before parents (reviewer probe)", async () => {
    const { ctx, events, clock, ac } = makeCtx();
    let toolCtx!: RunContext;
    const { ai } = fakeAI(
      [
        () => ({
          async *[Symbol.asyncIterator]() {
            yield p({ type: "start-step", request: {}, warnings: [] });
            yield p({ type: "tool-call", toolCallId: "c1", toolName: "fan", input: {} });
            runSubagent(sub, 0, toolCtx, "c1", 0).catch(() => {});
            await new Promise(() => {});
          },
        }),
        () => ({
          async *[Symbol.asyncIterator]() {
            yield p({ type: "start-step", request: {}, warnings: [] });
            await new Promise(() => {});
          },
        }),
      ],
      clock,
    );
    setTimeout(() => ac.abort(), 20);
    await runAgent(
      def((c) => {
        toolCtx = c;
        return {};
      }),
      [],
      "glm-5.3-flash",
      { ...ctx, ai },
    );
    await new Promise((r) => setTimeout(r, 30)); // let the subagent's own cleanup run
    expectWellFormed(events);
    expect(events.filter((e) => e.type === "span-start").map((e) => (e as { id: string }).id)).toContain("c1:sub:0:chat:0");
    for (const e of events) if (e.type === "span-end") expect(e.detail).toEqual({ error: "aborted" });
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "aborted" });
  });

  it("main-stream idle timeout aborts the run signal seen by tools and running subagents", async () => {
    vi.useFakeTimers();
    const { ctx, events, clock } = makeCtx();
    let toolCtx!: RunContext;
    let subSignal: AbortSignal | undefined;
    let subResult: Promise<unknown> | undefined;
    const { ai } = fakeAI(
      [
        () => ({
          async *[Symbol.asyncIterator]() {
            yield p({ type: "start-step", request: {}, warnings: [] });
            yield p({ type: "text-delta", id: "t", text: "hi" });
            const runId = (events[0] as Extract<TraceEvent, { type: "run-start" }>).runId;
            subResult = runSubagent(
              {
                ...sub,
                tools: (c) => {
                  subSignal = c.signal;
                  return {};
                },
              },
              0,
              toolCtx,
              runId,
              0,
            ).catch((e: unknown) => e);
            await new Promise(() => {});
          },
        }),
        () => ({
          async *[Symbol.asyncIterator]() {
            yield p({ type: "start-step", request: {}, warnings: [] });
            await new Promise(() => {});
          },
        }),
      ],
      clock,
    );
    const done = runAgent(
      def((c) => {
        toolCtx = c;
        return {};
      }),
      [],
      "glm-5.3-flash",
      { ...ctx, ai },
    );
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS + 1);
    await done;
    expect(ctx.signal.aborted).toBe(false);
    expect(toolCtx.signal.aborted).toBe(true);
    expect(subSignal?.aborted).toBe(true);
    expect(await subResult).toMatchObject({ name: "AbortError" });
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "error", error: "idle timeout" });
    expectWellFormed(events);
  });

  it("stream error and after() failure also abort the run signal", async () => {
    for (const mode of ["stream", "after"] as const) {
      const { ctx, clock } = makeCtx();
      let toolCtx!: RunContext;
      const { ai } = fakeAI(
        [
          (c) =>
            fakeStream(c, [
              { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
              mode === "stream"
                ? { at: 1, part: p({ type: "error", error: "boom" }) }
                : { at: 1, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
            ]),
        ],
        clock,
      );
      await runAgent(
        {
          ...def((c) => {
            toolCtx = c;
            return {};
          }),
          after: async () => {
            throw new Error("after failed");
          },
        },
        [],
        "glm-5.3-flash",
        { ...ctx, ai },
      );
      expect(toolCtx.signal.aborted).toBe(true);
      expect(ctx.signal.aborted).toBe(false);
    }
  });

  it("subagent idle aborts only its own child signal", async () => {
    vi.useFakeTimers();
    const { ctx, clock } = makeCtx();
    let subSignal: AbortSignal | undefined;
    const { ai } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 1, part: p({ type: "text-delta", id: "t", text: "x" }) },
            { hang: true },
          ]),
      ],
      clock,
    );
    const res = runSubagent(
      {
        ...sub,
        tools: (c) => {
          subSignal = c.signal;
          return {};
        },
      },
      0,
      { ...ctx, ai },
      "P",
      0,
    ).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS + 1);
    expect(((await res) as Error).message).toBe("idle timeout");
    expect(subSignal?.aborted).toBe(true);
    expect(ctx.signal.aborted).toBe(false);
  });
});

describe("tracing", () => {
  it("getTracedAI falls back to the plain ai namespace in node and memoizes per flag", async () => {
    const a = await getTracedAI({ storeContent: false });
    expect(a.streamText).toBe(aiNs.streamText);
    expect(await getTracedAI({ storeContent: false })).toBe(a);
  });

  it("span helpers are no-ops without a tracing runtime", () => {
    expect(() => setActiveSpanAttributes({ a: 1 })).not.toThrow();
    expect(() => recordActiveSpanException(new Error("x"))).not.toThrow();
  });

  it("span helpers use tracing.getActiveSpan() when present", () => {
    const span = { setAttribute: vi.fn(), recordException: vi.fn() };
    (globalThis as { __CF_WORKERS__?: unknown }).__CF_WORKERS__ = { tracing: { getActiveSpan: () => span } };
    setActiveSpanAttributes({ "cache.hit": true, n: 2 });
    expect(span.setAttribute).toHaveBeenCalledWith("cache.hit", true);
    expect(span.setAttribute).toHaveBeenCalledWith("n", 2);
    recordActiveSpanException("boom");
    expect(span.recordException).toHaveBeenCalledTimes(1);
  });
});
