import { useEffect, useState } from "react";
import { Check, Loader2, ShieldAlert, X, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { buildTimeline, type TimelineEvent, type TimelineStep } from "@/lib/chat-timeline";

export interface ChatTimeline {
  events: TimelineEvent[];
  /** ms since submit when the stream ended; null while still streaming. */
  endAt: number | null;
  /** performance.now() at submit — anchors the live clock. */
  startedAt: number;
}

const secs1 = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);

/**
 * Per-turn processing steps under an assistant message. While streaming it
 * shows the live step list; once finished it collapses into a one-line summary.
 */
export function ProcessTimeline({
  timeline,
  streaming,
  toolLabel,
}: {
  timeline: ChatTimeline;
  streaming: boolean;
  toolLabel: (name: string) => string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const live = streaming && timeline.endAt === null;

  // Re-render once a second while live so running steps tick.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

  const lastEventAt = timeline.events.length ? timeline.events[timeline.events.length - 1]!.t : 0;
  if (!live && timeline.events.length === 0) return null;

  // An interrupted turn may never have recorded endAt — close it at its last event.
  const endAt = live ? null : (timeline.endAt ?? lastEventAt);
  const now = live ? Math.max(performance.now() - timeline.startedAt, lastEventAt) : (endAt ?? 0);
  const steps = buildTimeline(timeline.events, endAt);

  const stepLabel = (s: TimelineStep) =>
    s.kind === "tool" ? t("chat.timeline.tool", { name: toolLabel(s.toolName ?? "") }) : t(`chat.timeline.${s.kind}`);

  const stepItem = (s: TimelineStep, i: number) => {
    const running = s.end === null;
    const duration = running ? `${Math.max(0, Math.floor((now - s.start) / 1000))}s` : `${secs1(s.end! - s.start)}s`;
    const icon =
      s.outcome === "blocked" ? (
        <ShieldAlert className="size-3 shrink-0 text-destructive" />
      ) : s.outcome === "error" ? (
        <X className="size-3 shrink-0 text-destructive" />
      ) : running ? (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      ) : (
        <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
      );
    return (
      <span key={i} className="inline-flex items-center gap-1 min-w-0">
        {icon}
        <span className={`truncate ${s.outcome === "blocked" || s.outcome === "error" ? "text-destructive" : ""}`}>
          {stepLabel(s)}
          {s.outcome === "blocked" && ` · ${t("chat.timeline.blocked")}`}
          {s.outcome === "error" && ` · ${t("chat.timeline.failed")}`}
        </span>
        <span className="tabular-nums text-muted-foreground/70">{duration}</span>
      </span>
    );
  };

  if (live) {
    return (
      <div className="py-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" />
          <span>{t("chat.timeline.processing", { s: Math.floor(now / 1000) })}</span>
        </div>
        <div className="mt-1 ml-[18px] flex flex-wrap items-center gap-x-3 gap-y-1">{steps.map(stepItem)}</div>
      </div>
    );
  }

  const toolCount = steps.filter((s) => s.kind === "tool").length;
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 px-2 py-1 -ml-2 rounded-lg hover:bg-muted/60 transition-colors cursor-pointer"
      >
        <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <span>{t("chat.timeline.summary", { s: secs1(endAt ?? 0), n: toolCount })}</span>
      </button>
      {expanded && (
        <div className="mt-1 ml-1 pl-3 border-l border-border/60 flex flex-col gap-1">{steps.map(stepItem)}</div>
      )}
    </div>
  );
}
