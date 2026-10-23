// Shared by server and browser: pure, immutable reducer from trace events to a span tree.
import type { ChartEvent, CitationEvent, SpanKind, TraceEvent } from "./trace-events";

export interface SpanNode {
  id: string;
  parentId?: string;
  kind: SpanKind;
  name: string;
  start: number;
  end: number | null;
  status?: "ok" | "error";
  usage?: { input: number; output: number };
  ttftMs?: number;
  detail?: unknown;
  children: SpanNode[];
}

export interface RunTrace {
  runId: string;
  agent: string;
  model: string;
  spans: Record<string, SpanNode>;
  rootIds: string[];
  text: string;
  reasoning: string;
  citations: CitationEvent["source"][];
  charts: ChartEvent["chart"][];
  ttftMs?: number;
  totalMs?: number;
  usage?: { input: number; output: number };
  status: "running" | "ok" | "error" | "aborted";
  error?: string;
  emptyAnswer: boolean;
}

function emptyTrace(runId = "", agent = "", model = ""): RunTrace {
  return {
    runId,
    agent,
    model,
    spans: {},
    rootIds: [],
    text: "",
    reasoning: "",
    citations: [],
    charts: [],
    status: "running",
    emptyAnswer: false,
  };
}

/**
 * Replace span `id` with `updater(node)` and re-create every ancestor so that
 * `spans[x].children` always holds the current child objects. Returns a new map.
 */
function updateSpan(
  spans: Record<string, SpanNode>,
  id: string,
  updater: (n: SpanNode) => SpanNode,
): Record<string, SpanNode> {
  const current = spans[id];
  if (!current) return spans;
  const next = { ...spans };
  let node = updater(current);
  next[id] = node;
  let parentId = node.parentId;
  while (parentId) {
    const parent: SpanNode | undefined = next[parentId];
    if (!parent) break;
    const replaced: SpanNode = {
      ...parent,
      children: parent.children.map((c) => (c.id === node.id ? node : c)),
    };
    next[parentId] = replaced;
    node = replaced;
    parentId = replaced.parentId;
  }
  return next;
}

export function reduceTrace(state: RunTrace | null, e: TraceEvent): RunTrace {
  if (e.type === "run-start") return emptyTrace(e.runId, e.agent, e.model);
  const s = state ?? emptyTrace();

  switch (e.type) {
    case "span-start": {
      if (s.spans[e.id]) return s;
      const parentKnown = e.parentId !== undefined && s.spans[e.parentId] !== undefined;
      const node: SpanNode = {
        id: e.id,
        ...(parentKnown ? { parentId: e.parentId } : {}),
        kind: e.kind,
        name: e.name,
        start: e.t,
        end: null,
        children: [],
      };
      if (!parentKnown) {
        return { ...s, spans: { ...s.spans, [e.id]: node }, rootIds: [...s.rootIds, e.id] };
      }
      const spans = updateSpan(s.spans, e.parentId as string, (p) => ({
        ...p,
        children: [...p.children, node],
      }));
      spans[e.id] = node;
      return { ...s, spans };
    }
    case "span-end": {
      if (!s.spans[e.id]) return s;
      const spans = updateSpan(s.spans, e.id, (n) => ({
        ...n,
        end: e.t,
        status: e.status,
        ...(e.usage !== undefined ? { usage: e.usage } : {}),
        ...(e.ttftMs !== undefined ? { ttftMs: e.ttftMs } : {}),
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
      }));
      return { ...s, spans };
    }
    case "text-delta":
      return { ...s, text: s.text + e.text };
    case "reasoning-delta":
      return { ...s, reasoning: s.reasoning + e.text };
    case "citation":
      return { ...s, citations: [...s.citations, e.source] };
    case "chart":
      return { ...s, charts: [...s.charts, e.chart] };
    case "run-end": {
      let spans = s.spans;
      if (e.status === "aborted") {
        for (const id of Object.keys(s.spans)) {
          if (spans[id]?.end === null) {
            spans = updateSpan(spans, id, (n) => ({ ...n, end: e.totalMs, status: "error" }));
          }
        }
      }
      return {
        ...s,
        spans,
        status: e.status,
        totalMs: e.totalMs,
        ttftMs: e.ttftMs,
        usage: e.usage,
        ...(e.error !== undefined ? { error: e.error } : {}),
        emptyAnswer: e.status === "ok" && s.text === "",
      };
    }
  }
}

/** Depth-first rows for the waterfall; siblings ordered by start (stable on insertion order). */
export function waterfallRows(trace: RunTrace): Array<{ node: SpanNode; depth: number }> {
  const rows: Array<{ node: SpanNode; depth: number }> = [];
  const byStart = (a: SpanNode, b: SpanNode) => a.start - b.start;
  const walk = (node: SpanNode, depth: number) => {
    rows.push({ node, depth });
    for (const child of [...node.children].sort(byStart)) walk(child, depth + 1);
  };
  const roots = trace.rootIds
    .map((id) => trace.spans[id])
    .filter((n): n is SpanNode => n !== undefined)
    .sort(byStart);
  for (const r of roots) walk(r, 0);
  return rows;
}
