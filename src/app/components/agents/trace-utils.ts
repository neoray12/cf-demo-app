'use client';

import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { AGENT_TOOL_LABEL_KEYS } from "@/lib/agents/catalog";
import { AGENT_MODELS, type ModelKey } from "@/lib/agents/models";
import type { RunTrace, SpanNode } from "@/lib/agents/trace-tree";
import type { AgentTurn } from "./use-agent-run";

/** Re-render every `intervalMs` while `active`; the interval stops as soon as `active` turns false. */
export function useNow(active: boolean, intervalMs = 100): number {
  const [now, setNow] = useState(() => (typeof performance !== "undefined" ? performance.now() : 0));
  useEffect(() => {
    if (!active) return;
    setNow(performance.now());
    const id = setInterval(() => setNow(performance.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** Current server-clock time (ms since the request reached the server) for a live turn. */
export function serverNow(turn: AgentTurn, now: number): number {
  if (turn.serverOffset !== undefined) return Math.max(0, now - turn.serverOffset);
  return Math.max(0, now - turn.sentAt);
}

/** End of a span: its own end, or the live server clock while it's still open. */
export function spanEnd(node: SpanNode, liveServerNow: number): number {
  return node.end ?? Math.max(node.start, liveServerNow);
}

export const secs = (ms: number | undefined, digits = 1): string =>
  ms === undefined ? "–" : `${(Math.max(0, ms) / 1000).toFixed(digits)}s`;

export const compact = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** i18n-friendly name for a span: tools and (sub)agents get labels; chat spans show the model label. */
export function spanLabel(node: SpanNode, t: TFunction): string {
  if (node.kind === "chat") {
    const model = AGENT_MODELS[node.name as ModelKey];
    return model ? t(model.labelKey) : node.name;
  }
  const key = AGENT_TOOL_LABEL_KEYS[node.name];
  return key ? t(key) : node.name;
}

/** Subagent ordinal from its span id (`{parent}:{functionId}:{index}`), 1-based. */
export function subagentOrdinal(node: SpanNode): number | undefined {
  const m = /:(\d+)$/.exec(node.id);
  return m ? Number(m[1]) + 1 : undefined;
}

/** Short preview of tool arguments: query / question / url / … or the JSON's first 80 chars. */
export function inputPreview(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") return truncate(input, 80);
  if (typeof input === "object" && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    for (const k of ["query", "question", "url", "domain"]) {
      if (typeof o[k] === "string" && o[k]) return truncate(o[k] as string, 80);
    }
    if (Array.isArray(o.questions)) return truncate((o.questions as unknown[]).map(String).join(" · "), 80);
    if (Array.isArray(o.analysts)) return truncate((o.analysts as unknown[]).map(String).join(", "), 80);
  }
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return undefined;
  }
  if (!json || json === "{}") return undefined;
  return truncate(json, 80);
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Last `n` non-empty lines of a streaming text. */
export function lastLines(s: string, n: number): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-n).join("\n");
}

export interface TraceCounts {
  tools: number;
  subagents: number;
}

export function traceCounts(trace: RunTrace): TraceCounts {
  let tools = 0;
  let subagents = 0;
  for (const n of Object.values(trace.spans)) {
    if (n.kind === "execute_tool") tools++;
    else if (n.kind === "invoke_agent" && n.id !== trace.runId) subagents++;
  }
  return { tools, subagents };
}

/** Client-side elapsed time of a turn, from send: frozen at run-end (or stream end), live otherwise. */
export function turnElapsed(turn: AgentTurn, now: number): number {
  if (turn.clientRunEndMs !== undefined) return turn.clientRunEndMs;
  if (turn.endedAt !== undefined) return turn.endedAt - turn.sentAt;
  return now - turn.sentAt;
}
