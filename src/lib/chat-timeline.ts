export type TimelineEvent =
  | { t: number; kind: "text" | "reasoning" }
  | { t: number; kind: "tool-start"; id: string; name: string }
  | { t: number; kind: "tool-end"; id: string; outcome: "done" | "error" | "blocked" };

export type TimelineStepKind = "waiting" | "reasoning" | "tool" | "composing" | "writing";

export interface TimelineStep {
  kind: TimelineStepKind;
  start: number;
  end: number | null;
  toolId?: string;
  toolName?: string;
  outcome?: "done" | "error" | "blocked";
}

/**
 * Turn a chat turn's timestamped stream events (ms since submit) into ordered
 * processing steps. `endAt` null means the stream is still running.
 */
export function buildTimeline(events: TimelineEvent[], endAt: number | null): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const openTools = new Map<string, TimelineStep>();
  let cur: TimelineStep | null = { kind: "waiting", start: 0, end: null };
  steps.push(cur);

  const switchTo = (kind: TimelineStepKind, t: number) => {
    if (cur && cur.kind === kind) return;
    if (cur) cur.end = t;
    cur = { kind, start: t, end: null };
    steps.push(cur);
  };

  for (const ev of events) {
    if (ev.kind === "text") {
      switchTo("writing", ev.t);
    } else if (ev.kind === "reasoning") {
      switchTo("reasoning", ev.t);
    } else if (ev.kind === "tool-start") {
      if (cur) cur.end = ev.t;
      cur = null;
      const step: TimelineStep = {
        kind: "tool",
        start: ev.t,
        end: null,
        toolId: ev.id,
        toolName: ev.name,
      };
      steps.push(step);
      openTools.set(ev.id, step);
    } else if (ev.kind === "tool-end") {
      const step = openTools.get(ev.id);
      if (!step) continue;
      step.end = ev.t;
      step.outcome = ev.outcome;
      openTools.delete(ev.id);
      if (openTools.size === 0 && !cur) {
        cur = { kind: "composing", start: ev.t, end: null };
        steps.push(cur);
      }
    }
  }

  if (endAt !== null) {
    for (const s of steps) if (s.end === null) s.end = endAt;
  }
  return steps;
}
