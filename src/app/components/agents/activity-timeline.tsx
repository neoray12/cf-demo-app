'use client';

import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Brain, Check, ChevronRight, CircleSlash, Loader2, Sparkles, Wrench, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { RunTrace, SpanNode } from "@/lib/agents/trace-tree";
import { cn } from "@/lib/utils";
import { turnStatus, type AgentTurn } from "./use-agent-run";
import {
  inputPreview,
  lastLines,
  secs,
  serverNow,
  spanEnd,
  spanLabel,
  isRetrySpan,
  subagentOrdinal,
  traceCounts,
  turnElapsed,
  useNow,
} from "./trace-utils";

const byStart = (a: SpanNode, b: SpanNode) => a.start - b.start;

function StatusIcon({ node, className }: { node: SpanNode; className?: string }) {
  if (node.end === null) return <Loader2 className={cn("size-3.5 shrink-0 animate-spin text-primary", className)} />;
  if (node.status === "error") return <X className={cn("size-3.5 shrink-0 text-destructive", className)} />;
  return <Check className={cn("size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400", className)} />;
}

function Duration({ node, now }: { node: SpanNode; now: number }) {
  return (
    <span className="tabular-nums text-muted-foreground/80 shrink-0">{secs(spanEnd(node, now) - node.start)}</span>
  );
}

/**
 * A root-agent model step while open: 「等待 Workers AI 模型回應」 until its first delta (the request is out, the
 * model hasn't streamed anything yet), then 「模型思考中」 (reasoning only) / 「撰寫回答中」. The chat span itself stays
 * open until its tools return (finish-step), so once a tool call of this step has started (`handoffAt`)
 * the model's part is shown as done, timed up to the hand-off.
 */
function ChatStep({
  node: span,
  index,
  isLast,
  runDone,
  handoffAt,
  now,
}: {
  node: SpanNode;
  index: number;
  isLast: boolean;
  runDone: boolean;
  handoffAt?: number;
  now: number;
}) {
  const { t } = useTranslation();
  const node: SpanNode =
    span.end === null && handoffAt !== undefined ? { ...span, end: handoffAt, status: "ok" } : span;
  const open = node.end === null;
  const label = open
    ? node.text
      ? t("agents.activity.writing")
      : node.reasoning
        ? t("agents.activity.thinking")
        : t("agents.activity.waitingModel")
    : runDone && isLast && node.text
      ? t("agents.activity.wrote")
      : index === 0
        ? t("agents.activity.planned")
        : t("agents.activity.thought");
  return (
    <div className="flex items-center gap-1.5 min-w-0 text-xs">
      {open ? <Sparkles className="size-3.5 shrink-0 text-primary animate-pulse" /> : <StatusIcon node={node} />}
      <span className={cn("truncate", open ? "text-foreground" : "text-muted-foreground", node.status === "error" && "text-destructive")}>
        {label}
      </span>
      <Duration node={node} now={now} />
    </div>
  );
}

function ToolChip({ node, now, small }: { node: SpanNode; now: number; small?: boolean }) {
  const { t } = useTranslation();
  const preview = inputPreview(node.input);
  const open = node.end === null;
  return (
    <div className={cn("flex items-center gap-1.5 min-w-0", small ? "text-[11px]" : "text-xs")}>
      <StatusIcon node={node} className={small ? "size-3" : undefined} />
      {!small && <Wrench className="size-3 shrink-0 text-muted-foreground" />}
      <span className={cn("shrink-0 font-medium", node.status === "error" && "text-destructive")}>{spanLabel(node, t)}</span>
      {preview ? (
        <span className="truncate text-muted-foreground font-mono text-[11px]">{preview}</span>
      ) : open ? (
        <span className="truncate text-muted-foreground/70 italic">{t("agents.activity.waitingInput")}</span>
      ) : null}
      <Duration node={node} now={now} />
    </div>
  );
}

function SubagentCard({ node, now }: { node: SpanNode; now: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const children = [...node.children].sort(byStart);
  const chats = children.filter((c) => c.kind === "chat");
  const tools = children.filter((c) => c.kind === "execute_tool");
  const text = chats.map((c) => c.text).filter(Boolean).join("\n");
  const reasoning = chats.map((c) => c.reasoning).filter(Boolean).join("\n");
  const stream = text || reasoning;
  const open = node.end === null;
  // The model is "thinking" only while its open step has not handed off to a tool call yet.
  const openChat = chats.find((c) => c.end === null);
  const activeChat = openChat && !tools.some((c) => c.start >= openChat.start) ? openChat : undefined;
  const ordinal = subagentOrdinal(node);
  const status = open ? "subagentRunning" : node.status === "error" ? "subagentFailed" : "subagentDone";

  return (
    <Card className="px-3 py-2 shadow-none bg-muted/30 gap-0">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <StatusIcon node={node} />
          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium truncate">
            {spanLabel(node, t)}
            {ordinal !== undefined && <span className="text-muted-foreground font-normal"> #{ordinal}</span>}
            {isRetrySpan(node) && (
              <span className="text-muted-foreground font-normal"> · {t("agents.trace.subagentRetry")}</span>
            )}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "px-1.5 py-0 text-[10px] font-normal shrink-0",
              open && "border-primary/40 text-primary",
              node.status === "error" && "border-destructive/50 text-destructive",
            )}
          >
            {t(`agents.activity.${status}`)}
          </Badge>
          <span className="ml-auto" />
          <Duration node={node} now={now} />
          {stream && (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={expanded ? t("agents.activity.hideFull") : t("agents.activity.showFull")}
                aria-label={expanded ? t("agents.activity.hideFull") : t("agents.activity.showFull")}
                aria-expanded={expanded}
              >
                <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
              </button>
            </CollapsibleTrigger>
          )}
        </div>
        {tools.length > 0 && (
          <div className="mt-1 ml-5 flex flex-col gap-0.5">
            {tools.map((c) => (
              <ToolChip key={c.id} node={c} now={now} small />
            ))}
          </div>
        )}
        {activeChat && (
          <div className="mt-1 ml-5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 animate-pulse text-primary" />
            <span>
              {activeChat.text || activeChat.reasoning ? t("agents.activity.summarizing") : t("agents.activity.waitingModel")}
            </span>
            <Duration node={activeChat} now={now} />
          </div>
        )}
        {stream && !expanded && (
          <p className="mt-1 ml-5 text-[11px] leading-snug text-muted-foreground whitespace-pre-wrap break-words line-clamp-2">
            {lastLines(stream, 2)}
          </p>
        )}
        <CollapsibleContent>
          <div className="mt-1 ml-5 max-h-64 overflow-y-auto rounded bg-background/60 p-2 text-[11px] leading-snug text-muted-foreground whitespace-pre-wrap break-words">
            {reasoning && text ? `${reasoning}\n\n${text}` : stream}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ToolStep({ node, now }: { node: SpanNode; now: number }) {
  const subagents = node.children.filter((c) => c.kind === "invoke_agent").sort(byStart);
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <ToolChip node={node} now={now} />
      {subagents.length > 0 && (
        <div className="ml-5 grid gap-1.5">
          {subagents.map((s) => (
            <SubagentCard key={s.id} node={s} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function RootReasoning({ trace, turn, live, now }: { trace: RunTrace; turn: AgentTurn; live: boolean; now: number }) {
  const { t } = useTranslation();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const root = trace.spans[trace.runId];
  const lastChat = root?.children.filter((c) => c.kind === "chat").sort(byStart).at(-1);
  const thinkingLive = live && !!lastChat && lastChat.end === null && lastChat.reasoning !== "" && lastChat.text === "";
  const first = turn.rootReasoningFirstMs ?? 0;
  const seconds = thinkingLive ? now - turn.sentAt - first : (turn.rootReasoningLastMs ?? first) - first;
  const open = userOpen ?? thinkingLive;
  return (
    <Collapsible open={open} onOpenChange={setUserOpen}>
      <CollapsibleTrigger className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <Brain className={cn("size-3.5", thinkingLive && "animate-pulse text-primary")} />
        <span>
          {thinkingLive
            ? t("agents.activity.thinkingFor", { s: (Math.max(0, seconds) / 1000).toFixed(1) })
            : t("agents.activity.thoughtFor", { s: (Math.max(0, seconds) / 1000).toFixed(1) })}
        </span>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-1 max-h-48 overflow-y-auto border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
          {trace.reasoning}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Open WebUI-style live process view between the user's message and the answer. Visible from the
 * moment of sending; open spans tick every 100 ms until run-end, then the step list collapses to a summary.
 */
export const ActivityTimeline = memo(function ActivityTimeline({ turn }: { turn: AgentTurn }) {
  const { t } = useTranslation();
  const status = turnStatus(turn);
  const live = status === "running";
  const now = useNow(live, 100);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const trace = turn.trace;
  const sNow = serverNow(turn, now);
  const elapsed = (turnElapsed(turn, now) / 1000).toFixed(1);

  const root = trace ? trace.spans[trace.runId] : undefined;
  const steps = root ? [...root.children].sort(byStart) : [];
  const chatSteps = steps.filter((s) => s.kind === "chat");
  const counts = trace ? traceCounts(trace) : { tools: 0, subagents: 0 };
  const expanded = userOpen ?? live;

  const statusText =
    status === "running"
      ? trace
        ? t("agents.activity.running", { s: elapsed })
        : `${t("agents.activity.waiting")} ${elapsed}s`
      : status === "ok"
        ? t("agents.activity.done", { s: elapsed })
        : status === "aborted"
          ? t("agents.activity.aborted", { s: elapsed })
          : t("agents.activity.failed", { s: elapsed });

  const statusIcon =
    status === "running" ? (
      <Loader2 className="size-3.5 animate-spin text-primary" />
    ) : status === "ok" ? (
      <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
    ) : status === "aborted" ? (
      <CircleSlash className="size-3.5 text-muted-foreground" />
    ) : (
      <X className="size-3.5 text-destructive" />
    );

  return (
    <div className="flex flex-col gap-1.5 text-xs" data-testid="activity-timeline">
      <Collapsible open={expanded} onOpenChange={setUserOpen}>
        <CollapsibleTrigger
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 hover:bg-muted/60 transition-colors",
            status === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {statusIcon}
          <span className={cn("tabular-nums", live && "text-foreground")}>{statusText}</span>
          {!live && (counts.tools > 0 || counts.subagents > 0) && (
            <span className="text-muted-foreground/70">
              · {t("agents.trace.tools")} {counts.tools} · {t("agents.trace.subagents")} {counts.subagents}
            </span>
          )}
          {steps.length > 0 && <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />}
        </CollapsibleTrigger>
        {trace && trace.reasoning && (
          <div className="mt-1">
            <RootReasoning trace={trace} turn={turn} live={live} now={now} />
          </div>
        )}
        <CollapsibleContent>
          {steps.length > 0 && (
            <div className="mt-1 ml-1.5 pl-3 border-l border-border/70 flex flex-col gap-1.5">
              {steps.map((s, i) =>
                s.kind === "chat" ? (
                  <ChatStep
                    key={s.id}
                    node={s}
                    index={chatSteps.indexOf(s)}
                    isLast={chatSteps.at(-1) === s}
                    runDone={!live}
                    // a tool started *after* this step's request (a prefetch span starts before chat:0 and isn't one)
                    handoffAt={steps.slice(i + 1).find((x) => x.kind !== "chat" && x.start > s.start)?.start}
                    now={sNow}
                  />
                ) : s.kind === "execute_tool" ? (
                  <ToolStep key={s.id} node={s} now={sNow} />
                ) : (
                  <SubagentCard key={s.id} node={s} now={sNow} />
                ),
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});
