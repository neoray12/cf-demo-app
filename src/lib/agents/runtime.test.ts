import * as aiNs from "ai";
import type { TextStreamPart, ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEnv } from "./env";
import {
  FIRST_PART_IDLE_MS,
  STREAM_IDLE_MS,
  SUBAGENT_STREAM_IDLE_MS,
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
      "span-input",
      "span-end",
      "span-end",
      "span-start",
      "text-delta",
      "span-end",
    ]);
    expect(events[0]).toEqual({ type: "span-start", id: "P:chat:0", parentId: "P", kind: "chat", name: "glm-5.3-flash", t: 0 });
    expect(events[1]).toEqual({ type: "reasoning-delta", spanId: "P:chat:0", text: "think" });
    expect(events[2]).toEqual({ type: "text-delta", spanId: "P:chat:0", text: "Hello" });
    expect(events[3]).toEqual({ type: "span-start", id: "P/c1", parentId: "P", kind: "execute_tool", name: "search_docs", t: 900 });
    expect(events[4]).toEqual({ type: "span-input", id: "P/c1", input: { q: "x" } });
    expect(events[5]).toMatchObject({ type: "span-end", id: "P/c1", t: 1000, status: "ok", detail: { input: { q: "x" }, output: { hits: 1 } } });
    expect(events[6]).toMatchObject({ type: "span-end", id: "P:chat:0", t: 1100, status: "ok", ttftMs: 500, usage: { input: 120, output: 30 } });
    expect(events[7]).toMatchObject({ type: "span-start", id: "P:chat:1", parentId: "P", kind: "chat", t: 1200 });
    expect(events[8]).toEqual({ type: "text-delta", spanId: "P:chat:1", text: " world" });
    expect(events[9]).toMatchObject({ type: "span-end", id: "P:chat:1", t: 1600, status: "ok", ttftMs: 300, usage: { input: 200, output: 10 } });

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
    const end = events.find((e) => e.type === "span-end" && e.id === "P/c9");
    expect(end).toEqual({ type: "span-end", id: "P/c9", t: 20, status: "error", detail: { error: "upstream 500" } });
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
    const end = events.find((e) => e.type === "span-end" && e.id === "P/c1") as Extract<TraceEvent, { type: "span-end" }>;
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

describe("pipeStepStream with execute-started tool spans", () => {
  it("does not re-emit span-start for a tool span already started by the execute wrapper", async () => {
    const { ctx, events, clock } = makeCtx();
    const started = new Set<string>(["P/c1"]);
    await pipeStepStream(
      fakeStream(clock, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 10, part: p({ type: "tool-call", toolCallId: "c1", toolName: "fan", input: { a: 1 } }) },
        { at: 20, part: p({ type: "tool-result", toolCallId: "c1", toolName: "fan", input: { a: 1 }, output: 2 }) },
        { at: 30, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true, startedToolSpans: started },
    );
    expect(events.filter((e) => e.type === "span-start" && e.id === "P/c1")).toHaveLength(0);
    expect(events.filter((e) => e.type === "span-end" && e.id === "P/c1")).toEqual([
      expect.objectContaining({ status: "ok", detail: { input: { a: 1 }, output: 2 } }),
    ]);
  });

  it("closes an execute-started tool span on abort even if its tool-call part never arrived", async () => {
    const { ctx, events, clock, ac } = makeCtx();
    const started = new Set<string>();
    const promise = pipeStepStream(
      fakeStream(clock, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        {
          at: 5,
          run: () => {
            started.add("c7"); // what the execute wrapper does before the part is consumed
            ac.abort();
          },
        },
        { hang: true },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true, startedToolSpans: started },
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(events.filter((e) => e.type === "span-end" && e.id === "c7")).toEqual([
      expect.objectContaining({ status: "error", detail: { error: "aborted" } }),
    ]);
  });
});

describe("pipeStepStream early tool spans (tool-input-start) and span-input", () => {
  const startStep = (at: number) => ({ at, part: p({ type: "start-step", request: {}, warnings: [] }) });
  const finishStep = (at: number) => ({
    at,
    part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool-calls" }),
  });

  it("starts the execute_tool span on tool-input-start, before tool-call; then one span-input and no second span-start", async () => {
    const { ctx, events, clock } = makeCtx();
    await pipeStepStream(
      fakeStream(clock, [
        startStep(0),
        { at: 100, part: p({ type: "tool-input-start", id: "c1", toolName: "search_docs" }) },
        { at: 150, part: p({ type: "tool-input-delta", id: "c1", delta: '{"query":' }) },
        { at: 200, part: p({ type: "tool-input-delta", id: "c1", delta: '"kv"}' }) },
        { at: 210, part: p({ type: "tool-input-end", id: "c1" }) },
        { at: 220, part: p({ type: "tool-call", toolCallId: "c1", toolName: "search_docs", input: { query: "kv" } }) },
        {
          at: 900,
          part: p({ type: "tool-result", toolCallId: "c1", toolName: "search_docs", input: { query: "kv" }, output: "ok" }),
        },
        finishStep(950),
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    const forTool = events.filter((e) => ("id" in e ? e.id : undefined) === "P/c1");
    expect(forTool).toEqual([
      { type: "span-start", id: "P/c1", parentId: "P", kind: "execute_tool", name: "search_docs", t: 100 },
      { type: "span-input", id: "P/c1", input: { query: "kv" } },
      expect.objectContaining({ type: "span-end", id: "P/c1", t: 900, status: "ok" }),
    ]);
    // the span-start is emitted when tool-input-start arrives, i.e. before the tool-call part
    expect(events.findIndex((e) => e.type === "span-start" && e.id === "P/c1")).toBe(1);
  });

  it("emits span-input only once when the execute wrapper already sent it", async () => {
    const { ctx, events, clock } = makeCtx();
    const started = new Set<string>(["P/c1"]);
    const inputs = new Set<string>(["P/c1"]);
    await pipeStepStream(
      fakeStream(clock, [
        startStep(0),
        { at: 10, part: p({ type: "tool-call", toolCallId: "c1", toolName: "fan", input: { a: 1 } }) },
        { at: 20, part: p({ type: "tool-result", toolCallId: "c1", toolName: "fan", input: { a: 1 }, output: 2 }) },
        finishStep(30),
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true, startedToolSpans: started, inputToolSpans: inputs },
    );
    expect(events.filter((e) => e.type === "span-input")).toHaveLength(0);
    expect(events.filter((e) => e.type === "span-start" && e.id === "P/c1")).toHaveLength(0);
  });

  it("span-input is JSON-safe and truncates strings to at most 500 chars", async () => {
    const { ctx, events, clock } = makeCtx();
    const long = "x".repeat(2000);
    await pipeStepStream(
      fakeStream(clock, [
        startStep(0),
        {
          at: 10,
          part: p({
            type: "tool-call",
            toolCallId: "c1",
            toolName: "t",
            input: { query: long, nested: { list: [long, 1] }, skip: undefined, fn: () => 1 },
          }),
        },
        { at: 20, part: p({ type: "tool-result", toolCallId: "c1", toolName: "t", input: {}, output: 1 }) },
        finishStep(30),
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    const ev = events.find((e) => e.type === "span-input") as Extract<TraceEvent, { type: "span-input" }>;
    const input = ev.input as { query: string; nested: { list: [string, number] } };
    expect(JSON.parse(JSON.stringify(ev.input))).toEqual(ev.input);
    expect(Object.keys(input).sort()).toEqual(["nested", "query"]);
    expect(input.query.length).toBeLessThanOrEqual(500);
    expect(input.query.startsWith("xxx")).toBe(true);
    expect(input.nested.list[0].length).toBeLessThanOrEqual(500);
    expect(input.nested.list[1]).toBe(1);
  });

  it("a tool started by tool-input-start gets exactly one span-end when the run aborts mid-arguments", async () => {
    const { ctx, events, clock, ac } = makeCtx();
    const promise = pipeStepStream(
      fakeStream(clock, [
        startStep(0),
        { at: 5, part: p({ type: "tool-input-start", id: "c1", toolName: "research" }) },
        { at: 6, part: p({ type: "tool-input-delta", id: "c1", delta: '{"questions":["a' }) },
        { at: 7, run: () => ac.abort() },
        { hang: true },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(events.filter((e) => e.type === "span-end" && e.id === "P/c1")).toEqual([
      expect.objectContaining({ status: "error", detail: { error: "aborted" } }),
    ]);
    expect(events.filter((e) => e.type === "span-input")).toHaveLength(0);
  });

  it("a tool started by tool-input-start is closed once if the stream ends (without finish-step) before its tool-call", async () => {
    const { ctx, events, clock } = makeCtx();
    await pipeStepStream(
      fakeStream(clock, [
        startStep(0),
        { at: 5, part: p({ type: "tool-input-start", id: "c1", toolName: "research" }) },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    );
    expect(events.filter((e) => e.type === "span-end" && e.id === "P/c1")).toEqual([
      expect.objectContaining({ status: "error", detail: { error: "no tool result" } }),
    ]);
  });

  it("idle is NOT suspended while a tool's arguments are still streaming (input phase): 60 s of silence times out", async () => {
    vi.useFakeTimers();
    const { ctx, events, clock } = makeCtx();
    const settled = pipeStepStream(
      fakeStream(clock, [
        startStep(0),
        { at: 0, part: p({ type: "text-delta", id: "t", text: "a" }) },
        { at: 0, part: p({ type: "tool-input-start", id: "c1", toolName: "fan" }) },
        { sleep: 70_000 },
        { at: 0, part: p({ type: "tool-call", toolCallId: "c1", toolName: "fan", input: {} }) },
        { at: 0, part: p({ type: "tool-result", toolCallId: "c1", toolName: "fan", input: {}, output: "ok" }) },
        finishStep(0),
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    ).then(
      () => "ok",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await settled).toBe("idle timeout");
    expect(events.filter((e) => e.type === "span-end" && e.id === "P/c1")).toEqual([
      expect.objectContaining({ status: "error", detail: { error: "idle timeout" } }),
    ]);
  });

  it("a tool whose arguments never completed is closed at its step's finish-step, and idle runs in the next step", async () => {
    vi.useFakeTimers();
    const { ctx, events, clock } = makeCtx();
    const settled = pipeStepStream(
      fakeStream(clock, [
        startStep(0),
        { at: 10, part: p({ type: "tool-input-start", id: "c1", toolName: "search_docs" }) },
        { at: 11, part: p({ type: "tool-input-delta", id: "c1", delta: '{"query":"k' }) },
        { at: 12, part: p({ type: "tool-input-start", id: "c2", toolName: "search_docs" }) },
        { at: 13, part: p({ type: "tool-call", toolCallId: "c2", toolName: "search_docs", input: { query: "d1" } }) },
        { at: 20, part: p({ type: "tool-result", toolCallId: "c2", toolName: "search_docs", input: {}, output: "ok" }) },
        finishStep(30),
        startStep(40),
        { at: 50, part: p({ type: "text-delta", id: "t", text: "answer" }) },
        { sleep: 61_000 },
        finishStep(70_000),
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "m", forwardText: true },
    ).then(
      () => "ok",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await settled).toBe("idle timeout");
    expect(events.filter((e) => e.type === "span-end" && e.id === "P/c1")).toEqual([
      { type: "span-end", id: "P/c1", t: 30, status: "error", detail: { error: "incomplete tool arguments" } },
    ]);
    // closed before its step's chat span
    const idx = (pred: (e: TraceEvent) => boolean) => events.findIndex(pred);
    expect(idx((e) => e.type === "span-end" && e.id === "P/c1")).toBeLessThan(idx((e) => e.type === "span-end" && e.id === "P:chat:0"));
    expect(events.filter((e) => e.type === "span-end" && e.id === "P/c2")).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(events.find((e) => e.type === "span-end" && e.id === "P:chat:1")).toMatchObject({ status: "error", detail: { error: "idle timeout" } });
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
    expect(events.find((e) => e.type === "span-end" && e.id === "P/c1")).toMatchObject({ status: "ok" });
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

  it("emits a nested invoke_agent span and forwards its text under its own chat span id", async () => {
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
    expect(events.filter((e) => e.type === "text-delta")).toEqual([
      { type: "text-delta", spanId: `${id}:chat:0`, text: "finding" },
    ]);

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
      metadata: { agentId: "docs-researcher-demo", conversationId: "conv-1", model: "glm-5.3-flash" },
    });
    expect(args.stopWhen).toBeTypeOf("function");
  });

  it("uses the context's languageModel hook instead of the Workers AI catalog", async () => {
    const { ctx, events, clock } = makeCtx();
    const { ai, calls } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 100, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 150, part: p({ type: "text-delta", id: "t", text: "ok" }) },
            { at: 200, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
          ]),
      ],
      clock,
    );
    const sentinel = { modelId: "anthropic/claude-haiku-5-5" };
    const requested: string[] = [];
    const languageModel = (functionId: string) => {
      requested.push(functionId);
      return { model: sentinel as never, label: "claude-haiku-5-5", maxOutputTokens: 2048 };
    };
    await runSubagent(def, { q: "x" }, { ...ctx, ai, languageModel }, "P", 0);

    const args = calls[0]!;
    expect(requested).toEqual(["docs-researcher"]);
    expect(args.model).toBe(sentinel);
    expect(args.maxOutputTokens).toBe(2048);
    expect(args.experimental_telemetry).toMatchObject({
      functionId: "docs-researcher",
      metadata: { model: "claude-haiku-5-5" },
    });
    expect(events.find((e) => e.type === "span-start" && e.kind === "chat")).toMatchObject({ name: expect.stringContaining("claude-haiku-5-5") });
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

  it("closes its span with an error, retries once, and rethrows when the retry fails too", async () => {
    const { ctx, events, clock } = makeCtx();
    const failing = (at: number) => (c: { t: number }) =>
      fakeStream(c, [
        { at, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: at + 3, part: p({ type: "error", error: "model overloaded" }) },
      ]);
    const { ai, calls } = fakeAI([failing(0), failing(10)], clock);
    await expect(runSubagent(def, { q: "x" }, { ...ctx, ai }, "P", 1)).rejects.toThrow("model overloaded");
    expect(calls).toHaveLength(2);
    const agentEnds = events.filter(
      (e) => e.type === "span-end" && (e.id === "P:docs-researcher:1" || e.id === "P:docs-researcher:1r"),
    );
    expect(agentEnds).toEqual([
      { type: "span-end", id: "P:docs-researcher:1", t: 3, status: "error", detail: { error: "model overloaded" } },
      { type: "span-end", id: "P:docs-researcher:1r", t: 13, status: "error", detail: { error: "model overloaded" } },
    ]);
    expect(events.at(-1)).toMatchObject({ id: "P:docs-researcher:1r", status: "error" });
  });

  it("retry (R32): the first attempt idles, the second succeeds → two invoke_agent spans, the first errored", async () => {
    vi.useFakeTimers();
    const { ctx, events, clock } = makeCtx();
    const { ai, calls } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 1, part: p({ type: "text-delta", id: "t", text: "half" }) },
            { hang: true },
          ]),
        (c) =>
          fakeStream(c, [
            { at: 50, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 51, part: p({ type: "text-delta", id: "t", text: "full finding" }) },
            { at: 52, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 2 }, finishReason: "stop" }) },
          ]),
      ],
      clock,
    );
    const res = runSubagent(def, { q: "x" }, { ...ctx, ai }, "P", 0);
    await vi.advanceTimersByTimeAsync(SUBAGENT_STREAM_IDLE_MS + 1);
    expect(await res).toEqual({ text: "full finding" });
    expect(calls).toHaveLength(2);

    const agentSpans = events.filter((e) => e.type === "span-start" && e.kind === "invoke_agent");
    expect(agentSpans).toEqual([
      { type: "span-start", id: "P:docs-researcher:0", parentId: "P", kind: "invoke_agent", name: "docs-researcher", t: 0 },
      { type: "span-start", id: "P:docs-researcher:0r", parentId: "P", kind: "invoke_agent", name: "docs-researcher", t: 1 },
    ]);
    const ends = events.filter((e) => e.type === "span-end" && agentSpans.some((s) => s.type === "span-start" && s.id === e.id));
    expect(ends).toEqual([
      { type: "span-end", id: "P:docs-researcher:0", t: 1, status: "error", detail: { error: "idle timeout" } },
      { type: "span-end", id: "P:docs-researcher:0r", t: 52, status: "ok", detail: { output: "full finding" } },
    ]);
  });

  it("does not retry when the run was aborted", async () => {
    const { ctx, ac, clock } = makeCtx();
    const { ai, calls } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 1, run: () => ac.abort() },
            { at: 2, part: p({ type: "text-delta", id: "t", text: "x" }) },
          ]),
      ],
      clock,
    );
    await expect(runSubagent(def, { q: "x" }, { ...ctx, ai }, "P", 0)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  it("uses the 45 s subagent idle window between parts (root stays at 60 s)", () => {
    expect(SUBAGENT_STREAM_IDLE_MS).toBe(45_000);
    expect(STREAM_IDLE_MS).toBe(60_000);
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
    expect(afterArgs[1]).toEqual({
      text: "Hello world",
      finalText: "world",
      finalFinishReason: "stop",
      rootSpanId: runId,
      toolResults: [{ toolName: "search_docs", output: { hits: 1 } }],
    });

    const args = calls[0]!;
    expect(args.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(args.system).toBe("sys");
    expect(args.maxOutputTokens).toBe(4000);
    expect(args.experimental_telemetry).toEqual({
      isEnabled: true,
      functionId: "docs-agent",
      metadata: { agentId: "docs-agent-demo", conversationId: "conv-1", model: "kimi-k2.6" },
    });
  });

  it("adds the workspace to telemetry metadata when the run has one (root and subagents)", async () => {
    const { ctx, clock } = makeCtx({ workspace: "ws-abcd1234" });
    const sub: SubagentDef<string> = {
      functionId: "r",
      model: "glm-5.3-flash",
      system: "s",
      maxSteps: 1,
      tools: () => ({}),
      prompt: (s) => s,
    };
    const { ai, calls } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 1, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 2, part: p({ type: "text-delta", id: "t", text: "ok" }) },
            { at: 3, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
          ]),
        (c) =>
          fakeStream(c, [
            { at: 4, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 5, part: p({ type: "text-delta", id: "t", text: "ok" }) },
            { at: 6, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
          ]),
      ],
      clock,
    );
    await runAgent(
      baseDef({ after: async (c, r) => void (await runSubagent(sub, "x", c, r.rootSpanId, 0)) }),
      [{ role: "user", content: "hi" }],
      "kimi-k2.6",
      { ...ctx, ai },
    );
    expect(calls.map((c) => (c.experimental_telemetry as { metadata: unknown }).metadata)).toEqual([
      { agentId: "docs-agent-demo", conversationId: "conv-1", model: "kimi-k2.6", workspace: "ws-abcd1234" },
      // subagents follow the run's model (ctx.modelKey)
      { agentId: "r-demo", conversationId: "conv-1", model: "kimi-k2.6", workspace: "ws-abcd1234" },
    ]);
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
        // subagent text is streamed as progress but is not the answer's first token
        { at: 25, part: p({ type: "text-delta", id: "t", text: "sub" }) },
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
            const rid = (events[0] as Extract<TraceEvent, { type: "run-start" }>).runId;
            runSubagent(sub, 0, toolCtx, `${rid}/c1`, 0).catch(() => {});
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
    expect(events.filter((e) => e.type === "span-start").map((e) => (e as { id: string }).id)).toContain(`${(events[0] as Extract<TraceEvent, { type: "run-start" }>).runId}/c1:sub:0:chat:0`);
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
    const subSignals: AbortSignal[] = [];
    const hanging = (c: { t: number }) =>
      fakeStream(c, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 1, part: p({ type: "text-delta", id: "t", text: "x" }) },
        { hang: true },
      ]);
    // first attempt + its one retry (R32) both idle
    const { ai } = fakeAI([hanging, hanging], clock);
    const res = runSubagent(
      {
        ...sub,
        tools: (c) => {
          subSignals.push(c.signal);
          return {};
        },
      },
      0,
      { ...ctx, ai },
      "P",
      0,
    ).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(SUBAGENT_STREAM_IDLE_MS + 1);
    await vi.advanceTimersByTimeAsync(SUBAGENT_STREAM_IDLE_MS + 1);
    expect(((await res) as Error).message).toBe("idle timeout");
    expect(subSignals).toHaveLength(2);
    expect(subSignals.every((s) => s.aborted)).toBe(true);
    expect(ctx.signal.aborted).toBe(false);
  });
});

describe("chat spans open when the model request is sent (prepareStep)", () => {
  const def: AgentDef = {
    id: "cloudflare-docs",
    functionId: "docs-agent",
    defaultModel: "glm-5.3-flash",
    maxSteps: 3,
    system: () => "sys",
    tools: () => ({}),
  };
  type PrepareStep = (o: { stepNumber: number }) => unknown;

  it("opens chat:N from prepareStep, reuses it on start-step, and measures ttft from the request", async () => {
    const { ctx, events, clock } = makeCtx();
    let prepare: PrepareStep | undefined;
    const ai = {
      ...aiNs,
      streamText: (args: { prepareStep?: PrepareStep }) => {
        prepare = args.prepareStep;
        clock.t = 5;
        prepare!({ stepNumber: 0 }); // the step-0 request goes out
        return {
          fullStream: fakeStream(clock, [
            { at: 50, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 60, part: p({ type: "text-delta", id: "t", text: "Hi" }) },
            // step 1's request can go out before the consumer has read step 0's finish-step
            { at: 70, run: () => void prepare!({ stepNumber: 1 }) },
            { at: 80, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool-calls" }) },
            { at: 200, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 260, part: p({ type: "text-delta", id: "t", text: "!" }) },
            { at: 300, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
          ]),
        };
      },
    } as unknown as typeof import("ai");
    await runAgent(def, [{ role: "user", content: "hi" }], "glm-5.3-flash", { ...ctx, ai });
    const runId = (events[0] as Extract<TraceEvent, { type: "run-start" }>).runId;
    const chatStarts = events.filter((e) => e.type === "span-start" && e.kind === "chat");
    expect(chatStarts).toEqual([
      { type: "span-start", id: `${runId}:chat:0`, parentId: runId, kind: "chat", name: "glm-5.3-flash", t: 5 },
      { type: "span-start", id: `${runId}:chat:1`, parentId: runId, kind: "chat", name: "glm-5.3-flash", t: 70 },
    ]);
    expect(events.find((e) => e.type === "span-end" && e.id === `${runId}:chat:0`)).toMatchObject({
      t: 80,
      status: "ok",
      ttftMs: 55,
      usage: { input: 1, output: 1 },
    });
    expect(events.find((e) => e.type === "span-end" && e.id === `${runId}:chat:1`)).toMatchObject({ t: 300, status: "ok", ttftMs: 190 });
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { spanId: string }).spanId)).toEqual([
      `${runId}:chat:0`,
      `${runId}:chat:1`,
    ]);
  });

  it("the last allowed step disables tools (toolChoice none, no active tools); earlier steps don't", async () => {
    const { ctx, clock } = makeCtx();
    const { ai, calls } = fakeAI([(c) => fakeStream(c, [{ at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) }])], clock);
    await runAgent(def, [{ role: "user", content: "hi" }], "glm-5.3-flash", { ...ctx, ai });
    const prepare = calls[0]!.prepareStep as PrepareStep;
    expect(prepare({ stepNumber: 0 })).not.toMatchObject({ toolChoice: "none" });
    expect(prepare({ stepNumber: 1 })).not.toMatchObject({ toolChoice: "none" });
    expect(prepare({ stepNumber: 2 })).toEqual({ toolChoice: "none", activeTools: [] });
  });

  it("closes a chat span that was requested but never started when the stream fails", async () => {
    const { ctx, events, clock } = makeCtx();
    const ai = {
      ...aiNs,
      streamText: (args: { prepareStep?: PrepareStep }) => {
        clock.t = 3;
        args.prepareStep!({ stepNumber: 0 });
        return { fullStream: fakeStream(clock, [{ at: 9, part: p({ type: "error", error: "upstream 502" }) }]) };
      },
    } as unknown as typeof import("ai");
    await runAgent(def, [{ role: "user", content: "hi" }], "glm-5.3-flash", { ...ctx, ai });
    const runId = (events[0] as Extract<TraceEvent, { type: "run-start" }>).runId;
    expect(events.filter((e) => e.type === "span-end" && e.id === `${runId}:chat:0`)).toEqual([
      expect.objectContaining({ status: "error", detail: { error: "upstream 502" } }),
    ]);
  });
});

describe("runAgent delta coalescing and filtering", () => {
  const def = (tools: AgentDef["tools"] = () => ({})): AgentDef => ({
    id: "cloudflare-docs",
    functionId: "docs-agent",
    defaultModel: "glm-5.3-flash",
    maxSteps: 3,
    system: () => "sys",
    tools,
  });

  it("100 deltas within 10 ms become at most 2 NDJSON events with the concatenated text; ttft uses the first raw delta", async () => {
    vi.useFakeTimers();
    const { ctx, events, clock } = makeCtx();
    const parts: Step[] = [{ at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) }];
    for (let i = 0; i < 100; i++) {
      if (i % 10 === 0) parts.push({ sleep: 1 });
      parts.push({ at: 30 + i / 10, part: p({ type: "text-delta", id: "t", text: `w${i} ` }) });
    }
    parts.push({ sleep: 200 });
    parts.push({ at: 400, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) });
    const { ai } = fakeAI([(c) => fakeStream(c, parts)], clock);
    const done = runAgent(def(), [{ role: "user", content: "hi" }], "glm-5.3-flash", { ...ctx, ai });
    await vi.advanceTimersByTimeAsync(500);
    await done;
    const deltas = events.filter((e) => e.type === "text-delta") as Extract<TraceEvent, { type: "text-delta" }>[];
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas.length).toBeLessThanOrEqual(2);
    expect(deltas.map((d) => d.text).join("")).toBe(Array.from({ length: 100 }, (_, i) => `w${i} `).join(""));
    // flushed by the 75 ms timer, i.e. well before the step ended
    const runId = (events[0] as Extract<TraceEvent, { type: "run-start" }>).runId;
    expect(events.indexOf(deltas.at(-1)!)).toBeLessThan(events.findIndex((e) => e.type === "span-end" && e.id === `${runId}:chat:0`));
    expect(events.at(-1)).toMatchObject({ type: "run-end", ttftMs: 30 });
  });

  it("a span-end arriving mid-batch is preceded by the flushed delta (ordering kept)", async () => {
    const { ctx, events, clock } = makeCtx();
    const { ai } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 1, part: p({ type: "reasoning-delta", id: "r", text: "th" }) },
            { at: 2, part: p({ type: "text-delta", id: "t", text: "a" }) },
            { at: 3, part: p({ type: "reasoning-delta", id: "r", text: "ink" }) },
            { at: 4, part: p({ type: "text-delta", id: "t", text: "b" }) },
            { at: 5, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
          ]),
      ],
      clock,
    );
    await runAgent(def(), [{ role: "user", content: "hi" }], "glm-5.3-flash", { ...ctx, ai });
    const runId = (events[0] as Extract<TraceEvent, { type: "run-start" }>).runId;
    const chatEnd = events.findIndex((e) => e.type === "span-end" && e.id === `${runId}:chat:0`);
    expect(events.slice(chatEnd - 2, chatEnd + 1)).toEqual([
      { type: "reasoning-delta", spanId: `${runId}:chat:0`, text: "think" },
      { type: "text-delta", spanId: `${runId}:chat:0`, text: "ab" },
      expect.objectContaining({ type: "span-end", id: `${runId}:chat:0` }),
    ]);
    expect(events.filter((e) => e.type === "text-delta" || e.type === "reasoning-delta")).toHaveLength(2);
  });

  it("drops deltas for spans that are not open, and only root-agent chat deltas set the run ttft", async () => {
    const { ctx, events, clock } = makeCtx();
    let toolCtx: RunContext | undefined;
    let runId = "";
    const { ai } = fakeAI(
      [
        (c) => ({
          async *[Symbol.asyncIterator]() {
            c.t = 10;
            yield p({ type: "start-step", request: {}, warnings: [] });
            c.t = 15;
            toolCtx!.emit({ type: "text-delta", spanId: "ghost", text: "x" }); // never opened
            toolCtx!.emit({ type: "text-delta", spanId: runId, text: "y" }); // open, but not a chat span
            c.t = 40;
            yield p({ type: "text-delta", id: "t", text: "done" });
            yield p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" });
          },
        }),
      ],
      clock,
    );
    const origEmit = ctx.emit;
    await runAgent(
      def((c) => {
        toolCtx = c;
        return {};
      }),
      [{ role: "user", content: "hi" }],
      "glm-5.3-flash",
      {
        ...ctx,
        ai,
        emit: (e) => {
          if (e.type === "run-start") runId = e.runId;
          origEmit(e);
        },
      },
    );
    expect(events.some((e) => e.type === "text-delta" && e.spanId === "ghost")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "ok", ttftMs: 40 });
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

describe("R30: the grounding checker only sees the final root answer step", () => {
  it("a plan sentence in step 0 and the answer in the last step → checker input excludes the plan sentence", async () => {
    const { kbAgent } = await import("./defs/knowledge-base");
    const { ctx, events, clock } = makeCtx({ workspace: "default" });
    // the prefetch's AI Search request finds nothing
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, result: { chunks: [] } }));
    const kbResult = { results: [{ n: 1, filename: "default/travel-expense.md", snippet: "台北住宿上限 3,200 元" }] };
    const { ai, calls } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 1, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 2, part: p({ type: "text-delta", id: "t", text: "我先查詢差旅規定。" }) },
            { at: 3, part: p({ type: "tool-call", toolCallId: "k1", toolName: "search_kb", input: { query: "住宿" } }) },
            { at: 4, part: p({ type: "tool-result", toolCallId: "k1", toolName: "search_kb", input: {}, output: kbResult }) },
            { at: 5, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool-calls" }) },
            { at: 6, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 7, part: p({ type: "text-delta", id: "t", text: "台北出差住宿上限為每晚 3,200 元 [1]。" }) },
            { at: 8, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
          ]),
        (c) =>
          fakeStream(c, [
            { at: 9, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 10, part: p({ type: "text-delta", id: "t", text: '{"unsupported":[]}' }) },
            { at: 11, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
          ]),
      ],
      clock,
    );
    await runAgent(kbAgent, [{ role: "user", content: "出差住宿上限多少？" }], "kimi-k2.6", { ...ctx, ai });
    expect(calls).toHaveLength(2);
    const checkerPrompt = calls[1]!.prompt as string;
    expect(calls[1]!.system).toContain("事實查核員");
    expect(checkerPrompt).toContain("台北出差住宿上限為每晚 3,200 元 [1]。");
    expect(checkerPrompt).not.toContain("我先查詢差旅規定");
    expect(checkerPrompt).toContain("[1] default/travel-expense.md");
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0]!.system).toContain("【預先檢索結果】");
    fetchMock.mockRestore();
  });

  it("finalText skips whitespace-only trailing steps and falls back to the whole text without step boundaries", async () => {
    const { ctx, clock } = makeCtx();
    const res = await pipeStepStream(
      fakeStream(clock, [
        { at: 1, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 2, part: p({ type: "text-delta", id: "t", text: " answer " }) },
        { at: 3, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool-calls" }) },
        { at: 4, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 5, part: p({ type: "text-delta", id: "t", text: "  " }) },
        { at: 6, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "kimi-k2.6", forwardText: false },
    );
    expect(res.finalText).toBe("answer");
    expect(res.finalFinishReason).toBe("stop");
    const bare = await pipeStepStream(
      fakeStream(clock, [{ at: 7, part: p({ type: "text-delta", id: "t", text: "no steps" }) }]),
      ctx,
      { parentSpanId: "Q", modelLabel: "kimi-k2.6", forwardText: false },
    );
    expect(bare.finalText).toBe("no steps");
    expect(bare.finalFinishReason).toBeUndefined();
  });

  it("finalFinishReason is the last step's finish reason (tool-calls when the step limit cut the run off)", async () => {
    const { ctx, clock } = makeCtx();
    const res = await pipeStepStream(
      fakeStream(clock, [
        { at: 1, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 2, part: p({ type: "text-delta", id: "t", text: "我先查一下。" }) },
        { at: 3, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool-calls" }) },
      ]),
      ctx,
      { parentSpanId: "P", modelLabel: "kimi-k2.6", forwardText: false },
    );
    expect(res.finalText).toBe("我先查一下。");
    expect(res.finalFinishReason).toBe("tool-calls");
  });
});

describe("user aborts are not recorded as span exceptions", () => {
  const def: AgentDef = {
    id: "cloudflare-docs",
    functionId: "docs-agent",
    defaultModel: "glm-5.3-flash",
    maxSteps: 3,
    system: () => "sys",
    tools: () => ({}),
  };
  const sub: SubagentDef<string> = {
    functionId: "r",
    model: "glm-5.3-flash",
    system: "s",
    maxSteps: 1,
    tools: () => ({}),
    prompt: (s) => s,
  };
  const installSpan = () => {
    const span = { setAttribute: vi.fn(), recordException: vi.fn() };
    (globalThis as { __CF_WORKERS__?: unknown }).__CF_WORKERS__ = { tracing: { getActiveSpan: () => span } };
    return span;
  };
  const abortingStream = (ac: AbortController) => (c: { t: number }) =>
    fakeStream(c, [
      { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
      { at: 1, run: () => ac.abort() },
      { at: 2, part: p({ type: "text-delta", id: "t", text: "x" }) },
    ]);

  it("runAgent: abort by the user → no recordException", async () => {
    const span = installSpan();
    const { ctx, ac, clock, events } = makeCtx();
    const { ai } = fakeAI([abortingStream(ac)], clock);
    await runAgent(def, [{ role: "user", content: "hi" }], "kimi-k2.6", { ...ctx, ai });
    expect(events.at(-1)).toMatchObject({ type: "run-end", status: "aborted" });
    expect(span.recordException).not.toHaveBeenCalled();
  });

  it("runSubagent: abort by the user → no recordException (and no retry)", async () => {
    const span = installSpan();
    const { ctx, ac, clock } = makeCtx();
    const { ai, calls } = fakeAI([abortingStream(ac)], clock);
    await expect(runSubagent(sub, "q", { ...ctx, ai }, "P", 0)).rejects.toMatchObject({ name: "AbortError" });
    expect(span.recordException).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("idle timeouts and stream errors are still recorded", async () => {
    vi.useFakeTimers();
    const span = installSpan();
    const { ctx, clock, events } = makeCtx();
    const { ai } = fakeAI(
      [
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 1, part: p({ type: "text-delta", id: "t", text: "x" }) },
            { hang: true },
          ]),
        (c) =>
          fakeStream(c, [
            { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
            { at: 1, part: p({ type: "error", error: "upstream 500" }) },
          ]),
      ],
      clock,
    );
    const run = runAgent(def, [{ role: "user", content: "hi" }], "kimi-k2.6", { ...ctx, ai });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS + 1);
    await vi.advanceTimersByTimeAsync(3000);
    await run;
    expect(events.find((e) => e.type === "run-end")).toMatchObject({ status: "error", error: "idle timeout" });
    expect(span.recordException).toHaveBeenCalledTimes(1);
    const second = runAgent(def, [{ role: "user", content: "hi" }], "kimi-k2.6", { ...ctx, ai });
    await vi.advanceTimersByTimeAsync(3000);
    await second;
    expect(span.recordException).toHaveBeenCalledTimes(2);
  });
});

describe("run-start reports whether tracing is active", () => {
  it("carries ctx.traced, and omits the field when the route didn't set it", async () => {
    const def: AgentDef = {
      id: "cloudflare-docs",
      functionId: "docs-agent",
      defaultModel: "glm-5.3-flash",
      maxSteps: 1,
      system: () => "sys",
      tools: () => ({}),
    };
    const stream = (c: { t: number }) =>
      fakeStream(c, [
        { at: 0, part: p({ type: "start-step", request: {}, warnings: [] }) },
        { at: 1, part: p({ type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) },
      ]);
    const a = makeCtx({ traced: false });
    await runAgent(def, [{ role: "user", content: "hi" }], "kimi-k2.6", { ...a.ctx, ai: fakeAI([stream], a.clock).ai });
    expect(a.events[0]).toMatchObject({ type: "run-start", traced: false });
    const b = makeCtx();
    await runAgent(def, [{ role: "user", content: "hi" }], "kimi-k2.6", { ...b.ctx, ai: fakeAI([stream], b.clock).ai });
    expect(b.events[0]).not.toHaveProperty("traced");
  });
});
