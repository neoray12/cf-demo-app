'use client';

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AGENT_MODELS, type ModelKey } from "@/lib/agents/models";
import { waterfallRows, type SpanNode } from "@/lib/agents/trace-tree";
import { cn } from "@/lib/utils";
import { SpanDetail } from "./span-detail";
import { compact, secs, serverNow, spanEnd, spanLabel, traceCounts, turnElapsed, useNow } from "./trace-utils";
import { turnStatus, type AgentTurn } from "./use-agent-run";

const BAR_COLORS: Record<SpanNode["kind"], string> = {
  invoke_agent: "bg-violet-500/80 dark:bg-violet-400/80",
  chat: "bg-sky-500/80 dark:bg-sky-400/80",
  execute_tool: "bg-amber-500/80 dark:bg-amber-400/80",
};
const DOT_COLORS: Record<SpanNode["kind"], string> = {
  invoke_agent: "bg-violet-500 dark:bg-violet-400",
  chat: "bg-sky-500 dark:bg-sky-400",
  execute_tool: "bg-amber-500 dark:bg-amber-400",
};

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-[11px] font-normal" title={title}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </Badge>
  );
}

/** Metric badges for one turn (also used under each answer on mobile, `compact`). */
export function TurnMetrics({ turn, now, compactRow }: { turn: AgentTurn; now: number; compactRow?: boolean }) {
  const { t } = useTranslation();
  const trace = turn.trace;
  const counts = trace ? traceCounts(trace) : { tools: 0, subagents: 0 };
  const usage = trace?.usage;
  const model = AGENT_MODELS[(trace?.model || turn.model) as ModelKey];
  const total = trace && trace.status !== "running" && trace.totalMs !== undefined ? trace.totalMs : turnElapsed(turn, now);

  if (compactRow) {
    return (
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
        <span>
          {t("agents.trace.firstEvent")} {secs(turn.clientFirstEventMs)}
        </span>
        <span>
          · {t("agents.trace.clientTtft")} {secs(turn.clientTtftMs)}
        </span>
        <span>
          · {t("agents.trace.total")} {secs(total)}
        </span>
        {usage && (
          <span>
            · {compact(usage.input)}→{compact(usage.output)} {t("agents.trace.tokens")}
          </span>
        )}
        <span>
          · {t("agents.trace.tools")} {counts.tools} · {t("agents.trace.subagents")} {counts.subagents}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <Metric label={t("agents.trace.firstEvent")} value={secs(turn.clientFirstEventMs, 2)} />
      <Metric label={t("agents.trace.firstReasoning")} value={secs(turn.clientFirstReasoningMs)} />
      <Metric label={t("agents.trace.clientTtft")} value={secs(turn.clientTtftMs)} />
      <Metric
        label={t("agents.trace.serverTtft")}
        value={trace?.status !== "running" && trace?.ttftMs ? secs(trace.ttftMs) : "–"}
      />
      <Metric label={t("agents.trace.total")} value={secs(total)} />
      <Metric
        label={t("agents.trace.tokens")}
        value={usage ? `${compact(usage.input)}→${compact(usage.output)}` : "–"}
      />
      <Metric label={t("agents.trace.tools")} value={String(counts.tools)} />
      <Metric label={t("agents.trace.subagents")} value={String(counts.subagents)} />
      <Metric label={t("agents.trace.model")} value={model ? t(model.labelKey) : turn.model} />
    </div>
  );
}

function Waterfall({
  turn,
  now,
  selectedId,
  onSelect,
}: {
  turn: AgentTurn;
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const trace = turn.trace;
  const rows = useMemo(() => (trace ? waterfallRows(trace) : []), [trace]);
  if (!trace || rows.length === 0) return null;
  const live = trace.status === "running";
  const sNow = serverNow(turn, now);
  const maxEnd = rows.reduce((m, r) => Math.max(m, spanEnd(r.node, sNow)), 0);
  const scale = Math.max(1, live ? Math.max(sNow, maxEnd) : Math.max(trace.totalMs ?? 0, maxEnd));
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / scale) * 100))}%`;

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{t("agents.trace.clickHint")}</span>
        <span className="tabular-nums">{secs(scale)}</span>
      </div>
      {rows.map(({ node, depth }) => {
        const end = spanEnd(node, sNow);
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
                {spanLabel(node, t)}
              </span>
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

/** Right-hand trace panel: per-turn metrics, live waterfall, span details. */
export function TracePanel({
  turns,
  selected,
  onSelect,
  className,
}: {
  turns: AgentTurn[];
  selected: number;
  onSelect: (index: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const turn = turns[selected];
  const live = !!turn && turnStatus(turn) === "running";
  const now = useNow(live, 200);
  const [spanSel, setSpanSel] = useState<{ turnId: string; spanId: string } | null>(null);
  const selectedSpanId = spanSel && turn && spanSel.turnId === turn.id ? spanSel.spanId : null;
  const selectedNode = selectedSpanId && turn?.trace ? turn.trace.spans[selectedSpanId] : undefined;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Activity className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("agents.trace.title")}</span>
        {live && <span className="ml-auto size-2 rounded-full bg-primary animate-pulse" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!turn ? (
          <p className="text-xs text-muted-foreground">{t("agents.trace.empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {turns.length > 1 && (
              <Tabs value={String(selected)} onValueChange={(v) => onSelect(Number(v))}>
                <TabsList className="h-8 max-w-full justify-start overflow-x-auto">
                  {turns.map((tn, i) => (
                    <TabsTrigger key={tn.id} value={String(i)} className="px-2 text-xs">
                      {t("agents.trace.turn", { n: i + 1 })}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}
            <TurnMetrics turn={turn} now={now} />
            {turn.trace?.status === "aborted" && (
              <p className="text-xs text-muted-foreground">{t("agents.trace.aborted")}</p>
            )}
            {turn.trace?.status === "error" && (
              <p className="text-xs text-destructive break-words">
                {t("agents.trace.error", { error: turn.trace.error ?? "" })}
              </p>
            )}
            <div>
              <div className="mb-1 text-xs font-medium">{t("agents.trace.waterfall")}</div>
              <Waterfall
                turn={turn}
                now={now}
                selectedId={selectedSpanId}
                onSelect={(spanId) => setSpanSel({ turnId: turn.id, spanId })}
              />
            </div>
            {selectedNode && (
              <SpanDetail node={selectedNode} now={serverNow(turn, now)} onClose={() => setSpanSel(null)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
