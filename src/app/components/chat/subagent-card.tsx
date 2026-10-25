'use client';

import { useTranslation } from "react-i18next";
import { Bot, Check, Loader2, X } from "lucide-react";
import type { RunTrace } from "@/lib/agents/trace-tree";
import { subagentView } from "@/lib/trace-summary";
import type { ToolCallInfo } from "@/lib/chat-turn";

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);

/**
 * An `ask_<server>` call: the subagent working through that MCP server —
 * its tool calls as they happen, the tail of its output, then its own time
 * and tokens.
 */
export function SubagentCard({
  toolCall,
  trace,
  serverLabel,
  toolLabel,
  sNow,
}: {
  toolCall: ToolCallInfo;
  trace: RunTrace | null | undefined;
  serverLabel: string;
  toolLabel: (name: string) => string;
  sNow: number;
}) {
  const { t } = useTranslation();
  const view = trace ? subagentView(trace, toolCall.id, sNow) : null;
  const result = toolCall.result as { codeMode?: boolean; error?: string } | undefined;
  const running = toolCall.status === "calling" || view?.running === true;
  const failed = toolCall.status === "error" || Boolean(result?.error);

  return (
    <div className="my-2 max-w-xl rounded-lg border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Bot className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="font-medium">{t("chat.subagent.title", { server: serverLabel })}</span>
        {result?.codeMode !== undefined && (
          <span className="rounded px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400">
            {result.codeMode ? "Code Mode" : t("chat.subagent.directTools")}
          </span>
        )}
        {running ? (
          <Loader2 className="ml-auto size-3 animate-spin text-muted-foreground" />
        ) : failed ? (
          <X className="ml-auto size-3 text-destructive" />
        ) : (
          <Check className="ml-auto size-3 text-emerald-600 dark:text-emerald-400" />
        )}
      </div>
      {view && view.tools.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {view.tools.map((tool, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                tool.status === "error" ? "bg-destructive/10 text-destructive" : "bg-background text-muted-foreground"
              }`}
            >
              {tool.status === "running" && <Loader2 className="size-2.5 animate-spin" />}
              {toolLabel(tool.name)}
              <span className="tabular-nums opacity-70">{secs(tool.durationMs)}s</span>
            </span>
          ))}
        </div>
      )}
      {running && view?.tail && <p className="mt-1.5 line-clamp-2 text-muted-foreground/80">{view.tail}</p>}
      {failed && result?.error && <p className="mt-1.5 text-destructive break-words">{result.error}</p>}
      {view && (
        <p className="mt-1.5 tabular-nums text-muted-foreground/70">
          {t("chat.subagent.stats", {
            s: secs(view.durationMs),
            calls: view.modelCalls,
            input: view.inputTokens.toLocaleString("en-US"),
            output: view.outputTokens.toLocaleString("en-US"),
          })}
        </p>
      )}
    </div>
  );
}
