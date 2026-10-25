'use client';

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { waterfallRows, type RunTrace, type SpanNode } from "@/lib/agents/trace-tree";
import { cn } from "@/lib/utils";

export const BAR_COLORS: Record<SpanNode["kind"], string> = {
  invoke_agent: "bg-violet-500/80 dark:bg-violet-400/80",
  chat: "bg-sky-500/80 dark:bg-sky-400/80",
  execute_tool: "bg-amber-500/80 dark:bg-amber-400/80",
};
const DOT_COLORS: Record<SpanNode["kind"], string> = {
  invoke_agent: "bg-violet-500 dark:bg-violet-400",
  chat: "bg-sky-500 dark:bg-sky-400",
  execute_tool: "bg-amber-500 dark:bg-amber-400",
};

const secs = (ms: number | undefined, digits = 1): string =>
  ms === undefined ? "–" : `${(Math.max(0, ms) / 1000).toFixed(digits)}s`;
const compact = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/**
 * Span waterfall shared by the Agents trace panel and the main chat's
 * processing details: one row per span (agent / model call / tool) with its
 * duration bar, time-to-first-token marker and tokens. `sNow` is the live
 * server-clock time for spans that are still open.
 */
export function TraceWaterfall({
  trace,
  sNow,
  selectedId,
  onSelect,
  label,
}: {
  trace: RunTrace;
  sNow: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  label: (node: SpanNode) => string;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => waterfallRows(trace), [trace]);
  if (rows.length === 0) return null;
  const live = trace.status === "running";
  const endOf = (n: SpanNode) => n.end ?? Math.max(n.start, sNow);
  const maxEnd = rows.reduce((m, r) => Math.max(m, endOf(r.node)), 0);
  const scale = Math.max(1, live ? Math.max(sNow, maxEnd) : Math.max(trace.totalMs ?? 0, maxEnd));
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / scale) * 100))}%`;

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{t("agents.trace.clickHint")}</span>
        <span className="tabular-nums">{secs(scale)}</span>
      </div>
      {rows.map(({ node, depth }) => {
        const end = endOf(node);
        const open = node.end === null;
        const error = node.status === "error";
        const ttftAt = node.kind === "chat" && node.ttftMs !== undefined ? node.start + node.ttftMs : undefined;
        return (
          <button
            type="button"
            key={node.id}
            onClick={() => onSelect(node.id)}
            className={cn(
              "grid grid-cols-[minmax(0,42%)_1fr] items-center gap-2 rounded px-1 py-[3px] text-left text-[11px] hover:bg-muted/60",
              selectedId === node.id && "bg-muted",
            )}
          >
            <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 10 }}>
              <span className={cn("size-1.5 shrink-0 rounded-full", error ? "bg-red-500" : DOT_COLORS[node.kind])} />
              <span className={cn("truncate", error && "text-destructive")} title={`${node.kind} ${node.name}`}>
                {label(node)}
              </span>
              {node.usage && (
                <span className="shrink-0 tabular-nums text-muted-foreground/70" title={t("agents.trace.tokens")}>
                  {compact(node.usage.input)}→{compact(node.usage.output)}
                </span>
              )}
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{secs(end - node.start)}</span>
            </span>
            <span className="relative h-3.5 rounded-sm bg-muted/50">
              <span
                className={cn(
                  "absolute top-0.5 bottom-0.5 rounded-sm",
                  error ? "bg-red-500/80" : BAR_COLORS[node.kind],
                  open && "animate-pulse",
                )}
                style={{ left: pct(node.start), width: `max(2px, ${pct(end - node.start)})` }}
              />
              {ttftAt !== undefined && (
                <span
                  className="absolute -bottom-1 -translate-x-1/2 text-[8px] leading-none text-foreground"
                  style={{ left: pct(ttftAt) }}
                  title={`${t("agents.trace.chatTtft")} ${secs(node.ttftMs, 2)}`}
                >
                  ▲
                </span>
              )}
            </span>
          </button>
        );
      })}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
        {(["invoke_agent", "chat", "execute_tool"] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className={cn("inline-block h-2 w-3 rounded-sm", BAR_COLORS[k])} />
            {t(k === "invoke_agent" ? "agents.trace.legendAgent" : k === "chat" ? "agents.trace.legendChat" : "agents.trace.legendTool")}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-red-500/80" />
          {t("agents.trace.legendError")}
        </span>
        <span className="inline-flex items-center gap-1">▲ {t("agents.trace.chatTtft")}</span>
      </div>
    </div>
  );
}
