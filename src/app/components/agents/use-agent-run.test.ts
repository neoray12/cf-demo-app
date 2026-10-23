import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@/lib/agents/trace-events";
import { reduceTrace, type RunTrace } from "@/lib/agents/trace-tree";
import { isRetrySpan, stripCitationMarkers, subagentOrdinal } from "./trace-utils";
import { buildHistory, canRetry, type AgentTurn } from "./use-agent-run";

function trace(steps: string[], status: "ok" | "error" | "aborted"): RunTrace {
  const events: TraceEvent[] = [
    { type: "run-start", runId: "r", agent: "knowledge-base", model: "kimi-k2.6", t: 0 },
    { type: "span-start", id: "r", kind: "invoke_agent", name: "kb-agent", t: 0 },
  ];
  steps.forEach((text, i) => {
    events.push(
      { type: "span-start", id: `r:chat:${i}`, parentId: "r", kind: "chat", name: "kimi-k2.6", t: i * 10 + 1 },
      { type: "text-delta", spanId: `r:chat:${i}`, text },
      { type: "span-end", id: `r:chat:${i}`, t: i * 10 + 5, status: "ok" },
    );
  });
  events.push({ type: "run-end", t: 100, totalMs: 100, ttftMs: 1, usage: { input: 0, output: 0 }, status });
  let s: RunTrace | null = null;
  for (const e of events) s = reduceTrace(s, e);
  return s!;
}

const turn = (over: Partial<AgentTurn>): AgentTurn => ({
  id: "t",
  user: "q",
  model: "kimi-k2.6",
  options: { model: "kimi-k2.6", storeContent: true },
  trace: null,
  sentAt: 0,
  endedAt: 1,
  ...over,
});

describe("stripCitationMarkers", () => {
  it("removes [n] markers only", () => {
    expect(stripCitationMarkers("上限 3,200 元[1][2]，詳見規定 [12]。")).toBe("上限 3,200 元，詳見規定 。");
    expect(stripCitationMarkers("array[i] and [a] stay")).toBe("array[i] and [a] stay");
  });
});

describe("buildHistory", () => {
  it("sends only ok turns' final step, without the plan sentence or [n] markers", () => {
    const history = buildHistory([
      turn({ id: "1", user: "住宿上限？", trace: trace(["我先查詢。", "台北每晚 3,200 元 [1]。"], "ok") }),
      turn({ id: "2", user: "失敗的問題", trace: trace(["我先查詢。"], "error") }),
      turn({ id: "3", user: "中止的問題", trace: trace(["部分"], "aborted") }),
      turn({ id: "4", user: "網路錯誤", trace: null, error: "HTTP 500" }),
    ]);
    expect(history).toEqual([
      { role: "user", content: "住宿上限？" },
      { role: "assistant", content: "台北每晚 3,200 元 。" },
    ]);
  });

  it("skips an ok turn whose answer is only citation markers", () => {
    expect(buildHistory([turn({ trace: trace(["[1][2]"], "ok") })])).toEqual([]);
  });
});

describe("canRetry", () => {
  it("is true for failed / stopped turns only", () => {
    expect(canRetry(turn({ trace: trace(["x"], "error") }))).toBe(true);
    expect(canRetry(turn({ trace: trace(["x"], "aborted") }))).toBe(true);
    expect(canRetry(turn({ error: "HTTP 400 · bad" }))).toBe(true);
    expect(canRetry(turn({ abortedEarly: true }))).toBe(true);
    expect(canRetry(turn({ trace: trace(["x"], "ok") }))).toBe(false);
    expect(canRetry(turn({ endedAt: undefined }))).toBe(false); // still running
  });
});

describe("subagent retry spans", () => {
  it("keeps the ordinal of the original attempt and marks the retry", () => {
    const node = (id: string) => ({ id, kind: "invoke_agent" as const });
    expect(subagentOrdinal({ ...node("P:docs-researcher:1r") } as never)).toBe(2);
    expect(subagentOrdinal({ ...node("P:docs-researcher:1") } as never)).toBe(2);
    expect(isRetrySpan(node("P:docs-researcher:1r"))).toBe(true);
    expect(isRetrySpan(node("P:docs-researcher:1"))).toBe(false);
    expect(isRetrySpan({ id: "x:chat:0r", kind: "chat" })).toBe(false);
  });
});
