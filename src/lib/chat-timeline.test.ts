import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineEvent } from "./chat-timeline";

describe("buildTimeline", () => {
  it("returns only a waiting step for empty events", () => {
    expect(buildTimeline([], null)).toEqual([{ kind: "waiting", start: 0, end: null }]);
    expect(buildTimeline([], 500)).toEqual([{ kind: "waiting", start: 0, end: 500 }]);
  });

  it("waiting -> reasoning -> writing", () => {
    const events: TimelineEvent[] = [
      { t: 3000, kind: "reasoning" },
      { t: 3500, kind: "reasoning" },
      { t: 5000, kind: "text" },
      { t: 5200, kind: "text" },
    ];
    expect(buildTimeline(events, 6000)).toEqual([
      { kind: "waiting", start: 0, end: 3000 },
      { kind: "reasoning", start: 3000, end: 5000 },
      { kind: "writing", start: 5000, end: 6000 },
    ]);
  });

  it("tool then composing then writing", () => {
    const events: TimelineEvent[] = [
      { t: 1000, kind: "text" },
      { t: 1500, kind: "tool-start", id: "a", name: "search" },
      { t: 3800, kind: "tool-end", id: "a", outcome: "done" },
      { t: 6000, kind: "text" },
    ];
    expect(buildTimeline(events, 7000)).toEqual([
      { kind: "waiting", start: 0, end: 1000 },
      { kind: "writing", start: 1000, end: 1500 },
      { kind: "tool", start: 1500, end: 3800, toolId: "a", toolName: "search", outcome: "done" },
      { kind: "composing", start: 3800, end: 6000 },
      { kind: "writing", start: 6000, end: 7000 },
    ]);
  });

  it("parallel tools: composing starts only after the last tool ends", () => {
    const events: TimelineEvent[] = [
      { t: 1000, kind: "tool-start", id: "a", name: "x" },
      { t: 1100, kind: "tool-start", id: "b", name: "y" },
      { t: 2000, kind: "tool-end", id: "b", outcome: "done" },
      { t: 3000, kind: "tool-end", id: "a", outcome: "done" },
    ];
    const steps = buildTimeline(events, null);
    expect(steps).toEqual([
      { kind: "waiting", start: 0, end: 1000 },
      { kind: "tool", start: 1000, end: 3000, toolId: "a", toolName: "x", outcome: "done" },
      { kind: "tool", start: 1100, end: 2000, toolId: "b", toolName: "y", outcome: "done" },
      { kind: "composing", start: 3000, end: null },
    ]);
  });

  it("marks blocked and error outcomes", () => {
    const events: TimelineEvent[] = [
      { t: 100, kind: "tool-start", id: "a", name: "x" },
      { t: 200, kind: "tool-end", id: "a", outcome: "blocked" },
      { t: 300, kind: "tool-start", id: "b", name: "y" },
      { t: 400, kind: "tool-end", id: "b", outcome: "error" },
    ];
    const tools = buildTimeline(events, 500).filter((s) => s.kind === "tool");
    expect(tools.map((s) => s.outcome)).toEqual(["blocked", "error"]);
  });

  it("closes open steps at end time", () => {
    const steps = buildTimeline([{ t: 1000, kind: "tool-start", id: "a", name: "x" }], 4000);
    expect(steps).toEqual([
      { kind: "waiting", start: 0, end: 1000 },
      { kind: "tool", start: 1000, end: 4000, toolId: "a", toolName: "x" },
    ]);
    expect(steps[1]?.outcome).toBeUndefined();
  });

  it("ends composing at a following reasoning or tool-start event", () => {
    const events: TimelineEvent[] = [
      { t: 100, kind: "tool-start", id: "a", name: "x" },
      { t: 200, kind: "tool-end", id: "a", outcome: "done" },
      { t: 500, kind: "reasoning" },
      { t: 700, kind: "tool-start", id: "b", name: "y" },
    ];
    const steps = buildTimeline(events, null);
    expect(steps.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["waiting", 0, 100],
      ["tool", 100, 200],
      ["composing", 200, 500],
      ["reasoning", 500, 700],
      ["tool", 700, null],
    ]);
  });
});
