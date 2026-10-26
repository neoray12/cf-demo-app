'use client';

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, Hand, Loader2, ShieldAlert, X } from "lucide-react";
import { isTerminal, type ApprovalStatus, type ApprovalView } from "@/lib/approvals";
import type { ApprovalRef } from "@/lib/mcp-subagent";

const POLL_MS = 2000;

const STATUS_STYLE: Record<ApprovalStatus, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  approved: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  executing: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString("zh-TW", { hour12: false });

/**
 * A write the subagent held back for a human: low risk is approved here by
 * the requester; high risk waits in a Cloudflare Workflow for the manager's
 * email link. Polls until the approval reaches a final state.
 */
export function ApprovalCard({ approval: initial }: { approval: ApprovalRef }) {
  const { t } = useTranslation();
  const [view, setView] = useState<ApprovalView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status: ApprovalStatus = view?.status ?? initial.status;

  const load = useCallback(async () => {
    const res = await fetch(`/api/approvals/${initial.id}`, { cache: "no-store" });
    if (res.ok) setView((await res.json()) as ApprovalView);
  }, [initial.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (isTerminal(status)) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${initial.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = (await res.json()) as ApprovalView & { error?: string };
      if (!res.ok) setError(body.error ?? `HTTP ${res.status}`);
      else setView(body as ApprovalView);
    } finally {
      setBusy(false);
    }
  };

  const high = initial.risk === "high";
  const detail = view ? (view.codeMode ? String(view.args.code ?? "") : JSON.stringify(view.args, null, 2)) : null;

  return (
    <div className="my-2 max-w-xl rounded-lg border border-amber-300/60 dark:border-amber-800/60 bg-amber-50/40 dark:bg-amber-950/10 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {high ? <ShieldAlert className="size-3.5 shrink-0 text-amber-600" /> : <Hand className="size-3.5 shrink-0 text-amber-600" />}
        <span className="font-medium">{high ? t("chat.approval.highRisk") : t("chat.approval.lowRisk")}</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[status]}`}>
          {(status === "executing" || (status === "approved" && !high)) && <Loader2 className="mr-1 inline size-2.5 animate-spin" />}
          {t(`chat.approval.status.${status}`)}
        </span>
      </div>
      <p className="mt-1.5 break-words">{view?.summary ?? initial.summary}</p>
      {status === "pending" && (
        <p className="mt-1 text-muted-foreground">{high ? t("chat.approval.waitingManager") : t("chat.approval.waitingYou")}</p>
      )}

      {detail && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-muted-foreground">{view?.codeMode ? t("chat.approval.script") : t("chat.approval.details")}</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 text-[11px] whitespace-pre-wrap">{detail}</pre>
        </details>
      )}

      {view && view.events.length > 0 && (
        <ol className="mt-2 space-y-0.5 border-l pl-2">
          {view.events.map((e, i) => (
            <li key={i} className="text-muted-foreground">
              <span className="tabular-nums opacity-70">{clock(e.at)}</span> {e.label}
            </li>
          ))}
        </ol>
      )}

      {view?.canDecide && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void decide("approve")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-background disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            {t("chat.approval.approve")}
          </button>
          <button
            onClick={() => void decide("reject")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 disabled:opacity-50"
          >
            <X className="size-3" />
            {t("chat.approval.reject")}
          </button>
        </div>
      )}

      {view?.status === "done" && view.result != null && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-emerald-700 dark:text-emerald-400">{t("chat.approval.result")}</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 text-[11px] whitespace-pre-wrap">
            {typeof view.result === "string" ? view.result : JSON.stringify(view.result, null, 2)}
          </pre>
        </details>
      )}
      {(view?.error || error) && <p className="mt-1.5 break-words text-destructive">{view?.error ?? error}</p>}

      {view?.workflowUrl && (
        <a href={view.workflowUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-muted-foreground hover:underline">
          <ExternalLink className="size-3" />
          {t("chat.approval.viewWorkflow")}
        </a>
      )}
    </div>
  );
}
