'use client';

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Check, ChevronDown, ChevronRight, Hand, Loader2, ShieldAlert, X } from "lucide-react";
import type { RunTrace } from "@/lib/agents/trace-tree";
import { subagentSteps, type CodeStep, type SubagentStep } from "@/lib/subagent-steps";
import type { ToolCallInfo } from "@/lib/chat-turn";

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);
const num = (n: number) => n.toLocaleString("en-US");
const TAIL_CHARS = 600;
const RESULT_CHARS = 4000;

const tail = (s: string, n = TAIL_CHARS) => (s.length > n ? `…${s.slice(-n)}` : s);
const show = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v);
  return s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}…` : s;
};

function StatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "writing") return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />;
  if (status === "error") return <X className="size-3 shrink-0 text-destructive" />;
  if (status === "blocked") return <ShieldAlert className="size-3 shrink-0 text-destructive" />;
  if (status === "approval") return <Hand className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />;
  return <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />;
}

const Pre = ({ children }: { children: string }) => (
  <pre className="mt-1 max-h-72 overflow-auto rounded bg-background p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
    {children}
  </pre>
);

function InnerSteps({ steps }: { steps: CodeStep[] }) {
  const { t } = useTranslation();
  return (
    <div className="mt-1.5 overflow-x-auto">
      <p className="text-muted-foreground">{t("chat.subagent.innerSteps", { n: steps.length })}</p>
      <table className="mt-1 w-full text-[11px]">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="pr-2 font-normal">#</th>
            <th className="pr-2 font-normal">{t("chat.subagent.colTool")}</th>
            <th className="pr-2 font-normal">{t("chat.subagent.colArgs")}</th>
            <th className="pr-2 text-right font-normal">{t("chat.subagent.colRows")}</th>
            <th className="text-right font-normal">ms</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={i} className={`border-t align-top ${s.error ? "text-destructive" : ""}`}>
              <td className="pr-2 tabular-nums">{i + 1}</td>
              <td className="pr-2 font-mono">{s.tool}</td>
              <td className="max-w-[16rem] truncate pr-2 font-mono" title={s.args === undefined ? "" : JSON.stringify(s.args)}>
                {s.error ?? (s.args === undefined ? "" : JSON.stringify(s.args))}
              </td>
              <td className="pr-2 text-right tabular-nums">{s.n ?? ""}</td>
              <td className="text-right tabular-nums">{s.ms ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Step({ step, toolLabel }: { step: SubagentStep; toolLabel: (name: string) => string }) {
  const { t } = useTranslation();
  if (step.kind === "prepare") {
    return (
      <li className="flex items-center gap-1.5">
        <StatusIcon status={step.status} />
        <span>{t("chat.subagent.prepare")}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{step.name}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">{secs(step.durationMs)}s</span>
      </li>
    );
  }
  if (step.kind === "model") {
    const live = step.status === "running";
    return (
      <li>
        <div className="flex items-center gap-1.5">
          <StatusIcon status={step.status} />
          <span>{t("chat.subagent.model", { n: step.index })}</span>
          {!live && (
            <span className="text-muted-foreground tabular-nums">
              {t("chat.subagent.modelTokens", { input: num(step.inputTokens), output: num(step.outputTokens) })}
            </span>
          )}
          <span className="ml-auto tabular-nums text-muted-foreground">{secs(step.durationMs)}s</span>
        </div>
        {step.reasoning && (
          <p className="mt-1 whitespace-pre-wrap break-words italic text-muted-foreground/80">{live ? tail(step.reasoning) : tail(step.reasoning, 300)}</p>
        )}
        {step.text && <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{tail(step.text, live ? TAIL_CHARS : 300)}</p>}
        {live && !step.reasoning && !step.text && <p className="mt-1 text-muted-foreground/70">{t("chat.subagent.waitingModel")}</p>}
      </li>
    );
  }
  const active = step.status === "writing" || step.status === "running";
  return (
    <li>
      <div className="flex items-center gap-1.5">
        <StatusIcon status={step.status} />
        <span className="font-medium">{toolLabel(step.name)}</span>
        <span
          className={`rounded px-1 py-0.5 text-[10px] ${
            step.status === "error" || step.status === "blocked"
              ? "bg-destructive/10 text-destructive"
              : step.status === "approval"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : "bg-background text-muted-foreground"
          }`}
        >
          {t(`chat.subagent.toolStatus.${step.status}`)}
        </span>
        <span className="ml-auto tabular-nums text-muted-foreground">{secs(step.durationMs)}s</span>
      </div>
      {step.code !== undefined && (
        <details open={active} className="mt-1">
          <summary className="cursor-pointer text-muted-foreground">{t("chat.subagent.script", { n: step.code.split("\n").length })}</summary>
          <Pre>{step.code}</Pre>
        </details>
      )}
      {step.code === undefined && step.args !== undefined && (
        <details className="mt-1">
          <summary className="cursor-pointer text-muted-foreground">{t("chat.subagent.args")}</summary>
          <Pre>{show(step.args)}</Pre>
        </details>
      )}
      {step.innerSteps && step.innerSteps.length > 0 && <InnerSteps steps={step.innerSteps} />}
      {step.error && <p className="mt-1 break-words text-destructive">{step.error}</p>}
      {step.status === "approval" && step.approvalId && (
        <p className="mt-1 text-amber-700 dark:text-amber-400">{t("chat.subagent.heldBack", { id: step.approvalId })}</p>
      )}
      {(step.result !== undefined || step.resultText !== undefined || step.output !== undefined) && (
        <details className="mt-1">
          <summary className="cursor-pointer text-muted-foreground">{t("chat.subagent.result")}</summary>
          <Pre>{show(step.resultText ?? step.result ?? step.output)}</Pre>
        </details>
      )}
    </li>
  );
}

/**
 * An `ask_<server>` call: the subagent's work step by step — tool loading, each
 * model call (live reasoning / text), each tool call with its arguments (a Code
 * Mode script appears as the model writes it), the script's own logged steps and
 * its result. Open while running; folds to one line when done.
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
  const [toggled, setToggled] = useState<boolean | null>(null);
  const view = trace ? subagentSteps(trace, toolCall.id, sNow) : null;
  const result = toolCall.result as { codeMode?: boolean; error?: string } | undefined;
  const running = toolCall.status === "calling" || view?.running === true;
  const failed = toolCall.status === "error" || Boolean(result?.error);
  const open = toggled ?? running;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="my-2 max-w-2xl rounded-lg border bg-muted/30 px-3 py-2 text-xs">
      <button type="button" onClick={() => setToggled(!open)} className="flex w-full flex-wrap items-center gap-1.5 text-left">
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
        <Bot className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="font-medium">{t("chat.subagent.title", { server: serverLabel })}</span>
        {result?.codeMode !== undefined && (
          <span className="rounded px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400">
            {result.codeMode ? "Code Mode" : t("chat.subagent.directTools")}
          </span>
        )}
        {view && <span className="ml-auto tabular-nums text-muted-foreground">{secs(view.durationMs)}s</span>}
        {running ? (
          <Loader2 className={`${view ? "" : "ml-auto "}size-3 animate-spin text-muted-foreground`} />
        ) : failed ? (
          <X className={`${view ? "" : "ml-auto "}size-3 text-destructive`} />
        ) : (
          <Check className={`${view ? "" : "ml-auto "}size-3 text-emerald-600 dark:text-emerald-400`} />
        )}
      </button>
      {open && view && view.steps.length > 0 && (
        <ol className="mt-2 space-y-2 border-l pl-3">
          {view.steps.map((step, i) => (
            <Step key={i} step={step} toolLabel={toolLabel} />
          ))}
        </ol>
      )}
      {open && view?.retried && <p className="mt-1.5 text-muted-foreground">{t("chat.subagent.retried")}</p>}
      {failed && result?.error && <p className="mt-1.5 text-destructive break-words">{result.error}</p>}
      {view && (
        <p className="mt-1.5 tabular-nums text-muted-foreground/70">
          {t("chat.subagent.stats", {
            s: secs(view.durationMs),
            calls: view.modelCalls,
            input: num(view.inputTokens),
            output: num(view.outputTokens),
          })}
        </p>
      )}
    </div>
  );
}
