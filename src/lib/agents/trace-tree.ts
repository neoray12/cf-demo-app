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
  /** Streamed text / reasoning of a chat span (subagent output shows up here as live progress). */
  text: string;
  reasoning: string;
  /** Tool arguments (execute_tool spans), from `span-input`. */
  input?: unknown;
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
      // Orphans keep their parentId; if this span is the parent they were waiting
      // for (events can arrive child-first), adopt them, ordered by start.
      const adopted = s.rootIds
        .map((id) => s.spans[id])
        .filter((n): n is SpanNode => n !== undefined && n.parentId === e.id)
        .sort((a, b) => a.start - b.start);
      const rootIds = adopted.length > 0 ? s.rootIds.filter((id) => !adopted.some((n) => n.id === id)) : s.rootIds;
      const node: SpanNode = {
        id: e.id,
        ...(e.parentId !== undefined ? { parentId: e.parentId } : {}),
        kind: e.kind,
        name: e.name,
        start: e.t,
        end: null,
        text: "",
        reasoning: "",
        children: adopted,
      };
      if (!parentKnown) {
        return { ...s, spans: { ...s.spans, [e.id]: node }, rootIds: [...rootIds, e.id] };
      }
      const spans = updateSpan(s.spans, e.parentId as string, (p) => ({
        ...p,
        children: [...p.children, node],
      }));
      spans[e.id] = node;
      return { ...s, spans, rootIds };
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
    case "span-input": {
      if (!s.spans[e.id]) return s;
      return { ...s, spans: updateSpan(s.spans, e.id, (n) => ({ ...n, input: e.input })) };
    }
    case "text-delta":
    case "reasoning-delta": {
      // Every delta belongs to the chat span that produced it. Only chat spans of the root agent
      // (parent = rootIds[0], i.e. the runId) are the answer; subagent output is progress only.
      const node = s.spans[e.spanId];
      if (!node) return s;
      const field = e.type === "text-delta" ? "text" : "reasoning";
      const spans = updateSpan(s.spans, e.spanId, (n) => ({ ...n, [field]: n[field] + e.text }));
      const isAnswer = node.kind === "chat" && node.parentId !== undefined && node.parentId === s.rootIds[0];
      return isAnswer ? { ...s, spans, [field]: s[field] + e.text } : { ...s, spans };
    }
    case "citation":
      return { ...s, citations: [...s.citations, e.source] };
    case "chart":
      return { ...s, charts: [...s.charts, e.chart] };
    case "run-end": {
      let spans = s.spans;
      if (e.status === "aborted" || e.status === "error") {
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
    default:
      return s;
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
