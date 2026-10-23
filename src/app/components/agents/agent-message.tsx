'use client';

import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, ChevronRight, ExternalLink, FileText, Wrench } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MarkdownRenderer } from "@/app/components/chat/markdown-renderer";
import { waterfallRows, type SpanNode } from "@/lib/agents/trace-tree";
import { cn } from "@/lib/utils";
import { ActivityTimeline } from "./activity-timeline";
import { TurnMetrics } from "./trace-panel";
import { displayAnswer, secs, spanLabel, truncate, useNow } from "./trace-utils";
import { turnStatus, type AgentTurn } from "./use-agent-run";

function detailText(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function CallRow({ node, depth }: { node: SpanNode; depth: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detail = detailText(node.detail);
  const input = node.input !== undefined ? detailText(node.input) : undefined;
  const hasBody = !!detail || !!input;
  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-muted/60 disabled:hover:bg-transparent"
      >
        {hasBody ? (
          <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        ) : (
          <span className="w-3" />
        )}
        {node.kind === "invoke_agent" ? (
          <Bot className="size-3 shrink-0 text-violet-500" />
        ) : (
          <Wrench className="size-3 shrink-0 text-amber-500" />
        )}
        <span className={cn("truncate", node.status === "error" && "text-destructive")}>{spanLabel(node, t)}</span>
        <span className="font-mono text-[10px] text-muted-foreground truncate">{node.name}</span>
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {node.end === null ? "…" : secs(node.end - node.start)}
        </span>
      </button>
      {open && hasBody && (
        <div className="ml-5 mt-0.5 mb-1 flex flex-col gap-1">
          {input && (
            <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 text-[11px] font-mono whitespace-pre-wrap break-all">
              {input}
            </pre>
          )}
          {detail && (
            <pre className="max-h-56 overflow-auto rounded bg-muted/60 p-2 text-[11px] font-mono whitespace-pre-wrap break-all">
              {detail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const isHttpUrl = (u: string | undefined): u is string => !!u && /^https?:\/\//i.test(u);

/**
 * One agent turn: live activity timeline, streamed answer, sources, tool/subagent calls, mobile metrics.
 * Memoized: patchTurn keeps the object identity of turns it doesn't touch, so finished turns skip re-rendering.
 */
export const AgentMessage = memo(function AgentMessage({ turn }: { turn: AgentTurn }) {
  const { t } = useTranslation();
  const status = turnStatus(turn);
  const live = status === "running";
  const now = useNow(false);
  const trace = turn.trace;

  const calls = useMemo(() => {
    if (!trace) return [];
    // Root agent is depth 0; show its tools and subagents (depth ≥ 1), skipping chat spans.
    return waterfallRows(trace).filter((r) => r.node.kind !== "chat" && r.node.id !== trace.runId);
  }, [trace]);

  // trace.text concatenates every root model step; separate the steps so the plan sentence written
  // before a tool call doesn't run into the final answer.
  const answer = useMemo(() => displayAnswer(trace), [trace]);

  // Citations keep their original 1-based number (answers cite [n]); repeated URLs from parallel searches collapse.
  const sources = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ c: NonNullable<typeof trace>["citations"][number]; n: number }> = [];
    (trace?.citations ?? []).forEach((c, i) => {
      const key = c.url ?? `${c.title}\n${c.snippet}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ c, n: i + 1 });
    });
    return out;
  }, [trace?.citations]);
  const [sourcesOpenState, setSourcesOpen] = useState<boolean | null>(null);
  // Short lists start open; long ones (parallel research) start collapsed so the answer stays in view.
  const sourcesOpen = sourcesOpenState ?? sources.length <= 4;

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <ActivityTimeline turn={turn} />

      {answer && <MarkdownRenderer content={answer} isStreaming={live} allowHtml={false} />}

      {trace?.emptyAnswer && <p className="text-sm text-muted-foreground italic">{t("agents.trace.emptyAnswer")}</p>}
      {status === "aborted" && <p className="text-xs text-muted-foreground">{t("agents.trace.aborted")}</p>}
      {trace?.status === "error" && (
        <p className="text-xs text-destructive break-words">{t("agents.trace.error", { error: trace.error ?? "" })}</p>
      )}
      {!trace && turn.error && (
        <p className="text-xs text-destructive break-words">{t("agents.chat.requestFailed", { error: turn.error })}</p>
      )}

      {sources.length > 0 && (
        <Collapsible open={sourcesOpen} onOpenChange={setSourcesOpen}>
          <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            {t("agents.chat.sourcesCount", { n: sources.length })}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-1 flex flex-col gap-0.5">
              {sources.map(({ c, n }) => (
                <li key={n} className="flex items-start gap-1.5 text-xs min-w-0" title={c.snippet ? truncate(c.snippet, 400) : undefined}>
                  <span className="shrink-0 tabular-nums text-muted-foreground">[{n}]</span>
                  <FileText className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  {isHttpUrl(c.url) ? (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-w-0 items-center gap-1 hover:underline"
                    >
                      <span className="truncate">{c.title || c.url}</span>
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="truncate">{c.title || c.url}</span>
                  )}
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      )}

      {!live && calls.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            {t("agents.chat.toolCalls", { n: calls.length })}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 rounded-lg border bg-muted/20 p-1.5">
              {calls.map(({ node, depth }) => (
                <CallRow key={node.id} node={node} depth={Math.max(0, depth - 1)} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {!live && (
        <div className="lg:hidden">
          <TurnMetrics turn={turn} now={now} compactRow />
        </div>
      )}
    </div>
  );
});
