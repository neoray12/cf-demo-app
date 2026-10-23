import { describe, expect, it } from "vitest";
import { reduceTrace, waterfallRows, type RunTrace } from "./trace-tree";
import type { TraceEvent } from "./trace-events";

const runStart: TraceEvent = { type: "run-start", runId: "r1", agent: "kb", model: "m", t: 0 };

function run(events: TraceEvent[]): RunTrace {
  let s: RunTrace | null = null;
  for (const e of events) s = reduceTrace(s, e);
  return s as RunTrace;
}

/** Root agent span (id = runId) plus its first chat span: deltas on "r1:chat:0" are the answer. */
const rootChat: TraceEvent[] = [
  { type: "span-start", id: "r1", kind: "invoke_agent", name: "main", t: 0 },
  { type: "span-start", id: "r1:chat:0", parentId: "r1", kind: "chat", name: "m", t: 1 },
];

const runEnd = (over: Partial<Extract<TraceEvent, { type: "run-end" }>> = {}): TraceEvent => ({
  type: "run-end",
  t: 3800,
  totalMs: 3800,
  ttftMs: 812,
  usage: { input: 10, output: 5 },
  status: "ok",
  ...over,
});

describe("reduceTrace", () => {
  it("run-start initialises a running trace", () => {
    const s = run([runStart]);
    expect(s).toMatchObject({
      runId: "r1",
      agent: "kb",
      model: "m",
      rootIds: [],
      text: "",
      reasoning: "",
      status: "running",
      emptyAnswer: false,
    });
  });

  it("nests child spans under parents", () => {
    const s = run([
      runStart,
      { type: "span-start", id: "a", kind: "invoke_agent", name: "kb-agent", t: 0 },
      { type: "span-start", id: "a:chat:0", parentId: "a", kind: "chat", name: "chat", t: 5 },
      { type: "span-end", id: "a:chat:0", t: 900, status: "ok", usage: { input: 3, output: 2 }, ttftMs: 400 },
    ]);
    expect(s.rootIds).toEqual(["a"]);
    expect(s.spans.a!.children[0]!.id).toBe("a:chat:0");
    expect(s.spans.a!.children[0]!.end).toBe(900);
    expect(s.spans["a:chat:0"]!.usage).toEqual({ input: 3, output: 2 });
    expect(s.spans["a:chat:0"]!.ttftMs).toBe(400);
    expect(s.spans["a:chat:0"]!.status).toBe("ok");
    // nested child inside parent is the updated node
    expect(s.spans.a!.children[0]).toEqual(s.spans["a:chat:0"]!);
  });

  it("is immutable", () => {
    const s1 = run([
      runStart,
      { type: "span-start", id: "a", kind: "invoke_agent", name: "x", t: 0 },
    ]);
    const snapshot = JSON.stringify(s1);
    const spanA = s1.spans.a;
    reduceTrace(s1, { type: "span-start", id: "a:chat:0", parentId: "a", kind: "chat", name: "c", t: 1 });
    reduceTrace(s1, { type: "span-end", id: "a", t: 9, status: "ok" });
    reduceTrace(s1, { type: "text-delta", spanId: "a", text: "z" });
    expect(JSON.stringify(s1)).toBe(snapshot);
    expect(s1.spans.a).toBe(spanA);
  });

  it("treats a span with unknown parent as a root", () => {
    const s = run([
      runStart,
      { type: "span-start", id: "x", parentId: "ghost", kind: "chat", name: "c", t: 0 },
    ]);
    expect(s.rootIds).toEqual(["x"]);
    expect(s.spans.x?.parentId).toBe("ghost");
  });

  it("adopts orphans when their parent span-start arrives later (child before parent)", () => {
    const s = run([
      runStart,
      { type: "span-start", id: "a", kind: "invoke_agent", name: "main", t: 0 },
      { type: "span-start", id: "t1:sub:1", parentId: "t1", kind: "invoke_agent", name: "sub", t: 12 },
      { type: "span-start", id: "t1:sub:0", parentId: "t1", kind: "invoke_agent", name: "sub", t: 10 },
      { type: "span-start", id: "t1:sub:0:chat:0", parentId: "t1:sub:0", kind: "chat", name: "m", t: 11 },
      { type: "span-start", id: "t1", parentId: "a", kind: "execute_tool", name: "fan", t: 5 },
      { type: "span-end", id: "t1:sub:0:chat:0", t: 20, status: "ok" },
    ]);
    expect(s.rootIds).toEqual(["a"]);
    const tool = s.spans.t1!;
    expect(tool.parentId).toBe("a");
    expect(tool.children.map((c) => c.id)).toEqual(["t1:sub:0", "t1:sub:1"]);
    expect(s.spans.a!.children.map((c) => c.id)).toEqual(["t1"]);
    // nested updates after adoption propagate up through the adopted chain
    expect(s.spans.a!.children[0]!.children[0]!.children[0]).toMatchObject({ id: "t1:sub:0:chat:0", end: 20 });
    expect(waterfallRows(s).map((r) => `${r.depth}:${r.node.id}`)).toEqual([
      "0:a",
      "1:t1",
      "2:t1:sub:0",
      "3:t1:sub:0:chat:0",
      "2:t1:sub:1",
    ]);
  });

  it("orders parallel subagents under a tool span by start then insertion", () => {
    const s = run([
      runStart,
      { type: "span-start", id: "a", kind: "invoke_agent", name: "docs-agent", t: 0 },
      { type: "span-start", id: "t1", parentId: "a", kind: "execute_tool", name: "research", t: 100 },
      { type: "span-start", id: "s1", parentId: "t1", kind: "invoke_agent", name: "r1", t: 150 },
      { type: "span-start", id: "s2", parentId: "t1", kind: "invoke_agent", name: "r2", t: 150 },
      { type: "span-start", id: "s3", parentId: "t1", kind: "invoke_agent", name: "r3", t: 150 },
      { type: "span-end", id: "s2", t: 700, status: "ok" },
      { type: "span-end", id: "s3", t: 1200, status: "ok" },
      { type: "span-end", id: "s1", t: 2000, status: "ok" },
      { type: "span-end", id: "t1", t: 2000, status: "ok" },
    ]);
    const rows = waterfallRows(s);
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([
      ["a", 0],
      ["t1", 1],
      ["s1", 2],
      ["s2", 2],
      ["s3", 2],
    ]);
    const rowEnd = (id: string) => rows.find((r) => r.node.id === id)!.node.end;
    expect(rowEnd("s1")).toBe(2000);
    expect(rowEnd("s2")).toBe(700);
    expect(rowEnd("s3")).toBe(1200);
    expect(s.spans.a!.children[0]!.children[0]!.end).toBe(2000);
    expect(s.spans.a!.children[0]!.children[2]!.end).toBe(1200);
  });

  it("sorts siblings by start time", () => {
    const s = run([
      runStart,
      { type: "span-start", id: "a", kind: "invoke_agent", name: "a", t: 0 },
      { type: "span-start", id: "late", parentId: "a", kind: "chat", name: "late", t: 500 },
      { type: "span-start", id: "early", parentId: "a", kind: "chat", name: "early", t: 100 },
    ]);
    expect(waterfallRows(s).map((r) => r.node.id)).toEqual(["a", "early", "late"]);
  });

  it("accumulates root-agent text and reasoning, collects citations and charts", () => {
    const chart = { kind: "bar" as const, title: "t", unit: "%", period: "7d", data: [{ label: "a", value: 1 }], sourceUrl: "u" };
    const s = run([
      runStart,
      ...rootChat,
      { type: "text-delta", spanId: "r1:chat:0", text: "Hel" },
      { type: "text-delta", spanId: "r1:chat:0", text: "lo" },
      { type: "reasoning-delta", spanId: "r1:chat:0", text: "th" },
      { type: "reasoning-delta", spanId: "r1:chat:0", text: "ink" },
      { type: "citation", spanId: "a", source: { title: "T", snippet: "S" } },
      { type: "chart", spanId: "a", chart },
    ]);
    expect(s.text).toBe("Hello");
    expect(s.reasoning).toBe("think");
    // the chat span keeps its own copy (and the copy nested in the parent is the same node)
    expect(s.spans["r1:chat:0"]).toMatchObject({ text: "Hello", reasoning: "think" });
    expect(s.spans.r1!.children[0]).toBe(s.spans["r1:chat:0"]);
    expect(s.citations).toEqual([{ title: "T", snippet: "S" }]);
    expect(s.charts).toEqual([chart]);
  });

  it("new spans start with empty text and reasoning", () => {
    const s = run([runStart, ...rootChat]);
    expect(s.spans.r1).toMatchObject({ text: "", reasoning: "" });
    expect(s.spans["r1:chat:0"]).toMatchObject({ text: "", reasoning: "" });
    expect(s.spans.r1!.input).toBeUndefined();
  });

  it("subagent chat deltas go only to that span, never to the run answer", () => {
    const s = run([
      runStart,
      ...rootChat,
      { type: "span-start", id: "r1/c1", parentId: "r1", kind: "execute_tool", name: "research", t: 2 },
      { type: "span-start", id: "r1/c1:sub:0", parentId: "r1/c1", kind: "invoke_agent", name: "sub", t: 3 },
      { type: "span-start", id: "r1/c1:sub:0:chat:0", parentId: "r1/c1:sub:0", kind: "chat", name: "m", t: 4 },
      { type: "reasoning-delta", spanId: "r1/c1:sub:0:chat:0", text: "sub-think" },
      { type: "text-delta", spanId: "r1/c1:sub:0:chat:0", text: "sub-" },
      { type: "text-delta", spanId: "r1/c1:sub:0:chat:0", text: "out" },
      { type: "text-delta", spanId: "r1:chat:0", text: "answer" },
    ]);
    expect(s.text).toBe("answer");
    expect(s.reasoning).toBe("");
    expect(s.spans["r1/c1:sub:0:chat:0"]).toMatchObject({ text: "sub-out", reasoning: "sub-think" });
    // nested copies are refreshed all the way up
    expect(s.spans.r1!.children.find((c) => c.id === "r1/c1")!.children[0]!.children[0]).toBe(
      s.spans["r1/c1:sub:0:chat:0"],
    );
  });

  it("emptyAnswer only looks at the root agent's text", () => {
    const s = run([
      runStart,
      ...rootChat,
      { type: "span-start", id: "sub", parentId: "r1", kind: "invoke_agent", name: "sub", t: 3 },
      { type: "span-start", id: "sub:chat:0", parentId: "sub", kind: "chat", name: "m", t: 4 },
      { type: "text-delta", spanId: "sub:chat:0", text: "only the subagent spoke" },
      runEnd(),
    ]);
    expect(s.text).toBe("");
    expect(s.emptyAnswer).toBe(true);
  });

  it("text-delta / reasoning-delta for an unknown span id are ignored (same state)", () => {
    const s1 = run([runStart, ...rootChat]);
    expect(reduceTrace(s1, { type: "text-delta", spanId: "ghost", text: "x" })).toBe(s1);
    expect(reduceTrace(s1, { type: "reasoning-delta", spanId: "ghost", text: "x" })).toBe(s1);
  });

  it("span-input sets node.input; unknown id returns the same state", () => {
    const s1 = run([
      runStart,
      ...rootChat,
      { type: "span-start", id: "r1/c1", parentId: "r1", kind: "execute_tool", name: "search_docs", t: 2 },
      { type: "span-input", id: "r1/c1", input: { query: "kv" } },
    ]);
    expect(s1.spans["r1/c1"]!.input).toEqual({ query: "kv" });
    expect(s1.spans.r1!.children.find((c) => c.id === "r1/c1")).toBe(s1.spans["r1/c1"]);
    expect(reduceTrace(s1, { type: "span-input", id: "nope", input: 1 })).toBe(s1);
  });

  it("run-end records metrics and status", () => {
    const s = run([runStart, ...rootChat, { type: "text-delta", spanId: "r1:chat:0", text: "x" }, runEnd()]);
    expect(s.ttftMs).toBe(812);
    expect(s.totalMs).toBe(3800);
    expect(s.usage).toEqual({ input: 10, output: 5 });
    expect(s.status).toBe("ok");
    expect(s.emptyAnswer).toBe(false);
  });

  it("flags emptyAnswer when ok but no text was streamed", () => {
    expect(run([runStart, runEnd()]).emptyAnswer).toBe(true);
    expect(run([runStart, runEnd({ status: "error", error: "boom" })])).toMatchObject({
      emptyAnswer: false,
      status: "error",
      error: "boom",
    });
  });

  it("aborted closes open spans at totalMs with error status", () => {
    const s = run([
      runStart,
      { type: "span-start", id: "a", kind: "invoke_agent", name: "a", t: 0 },
      { type: "span-start", id: "c", parentId: "a", kind: "chat", name: "c", t: 10 },
      { type: "span-start", id: "done", parentId: "a", kind: "execute_tool", name: "t", t: 20 },
      { type: "span-end", id: "done", t: 30, status: "ok" },
      { type: "span-start", id: "deep", parentId: "c", kind: "execute_tool", name: "d", t: 40 },
      runEnd({ status: "aborted", totalMs: 1500 }),
    ]);
    const rows = waterfallRows(s);
    const deep = rows.find((r) => r.node.id === "deep")!;
    expect(deep.depth).toBe(2);
    expect(deep.node).toMatchObject({ end: 1500, status: "error" });
    expect(rows.find((r) => r.node.id === "a")!.node).toMatchObject({ end: 1500, status: "error" });
    expect(rows.find((r) => r.node.id === "done")!.node).toMatchObject({ end: 30, status: "ok" });
    expect(s.status).toBe("aborted");
    expect(s.spans.a!).toMatchObject({ end: 1500, status: "error" });
    expect(s.spans.c!).toMatchObject({ end: 1500, status: "error" });
    expect(s.spans.done!).toMatchObject({ end: 30, status: "ok" });
    expect(s.spans.a!.children.find((c) => c.id === "c")).toMatchObject({ end: 1500, status: "error" });
    expect(s.emptyAnswer).toBe(false);
  });

  it("keeps detail on errored span-end", () => {
    const s = run([
      runStart,
      { type: "span-start", id: "t", kind: "execute_tool", name: "t", t: 0 },
      { type: "span-end", id: "t", t: 5, status: "error", detail: { message: "nope" } },
    ]);
    expect(s.spans.t!.status).toBe("error");
    expect(s.spans.t!.detail).toEqual({ message: "nope" });
  });

  it("ignores span-end for unknown spans", () => {
    const s1 = run([runStart]);
    expect(reduceTrace(s1, { type: "span-end", id: "nope", t: 1, status: "ok" })).toBe(s1);
  });

  it("error run-end also closes open spans, emptyAnswer stays false", () => {
    const s = run([
      runStart,
      { type: "span-start", id: "a", kind: "invoke_agent", name: "a", t: 0 },
      { type: "span-start", id: "c", parentId: "a", kind: "chat", name: "c", t: 10 },
      { type: "span-start", id: "deep", parentId: "c", kind: "execute_tool", name: "d", t: 40 },
      runEnd({ status: "error", error: "boom", totalMs: 900 }),
    ]);
    const rows = waterfallRows(s);
    for (const id of ["a", "c", "deep"]) {
      expect(rows.find((r) => r.node.id === id)!.node).toMatchObject({ end: 900, status: "error" });
    }
    expect(s.status).toBe("error");
    expect(s.emptyAnswer).toBe(false);
  });

  it("ignores unknown event types without touching state", () => {
    const s1 = run([runStart, ...rootChat, { type: "text-delta", spanId: "r1:chat:0", text: "x" }]);
    const future = { type: "future-event", foo: 1 } as unknown as TraceEvent;
    expect(reduceTrace(s1, future)).toBe(s1);
  });
});
