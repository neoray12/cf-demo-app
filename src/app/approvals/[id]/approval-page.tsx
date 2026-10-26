'use client';

import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, ShieldAlert, X } from "lucide-react";
import { isTerminal, type ApprovalStatus, type ApprovalView } from "@/lib/approvals";

const STATUS: Record<ApprovalStatus, string> = {
  pending: "等待核准",
  approved: "已核准，Workflow 正在寫入",
  executing: "寫入中",
  done: "已完成",
  rejected: "已拒絕",
  expired: "已逾時",
  failed: "失敗",
};

const time = (ms: number) => new Date(ms).toLocaleString("zh-TW", { hour12: false });

export function ApprovalPage({ id, token }: { id: string; token: string | null }) {
  const [view, setView] = useState<ApprovalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const q = token ? `?t=${encodeURIComponent(token)}` : "";
  const load = useCallback(async () => {
    const res = await fetch(`/api/approvals/${id}${q}`, { cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as ApprovalView & { error?: string };
    if (res.ok) setView(body);
    else setError(res.status === 403 ? "連結無效或已過期。" : body.error ?? `HTTP ${res.status}`);
  }, [id, q]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!view || isTerminal(view.status)) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [view, load]);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, t: token }),
      });
      const body = (await res.json().catch(() => ({}))) as ApprovalView & { error?: string };
      if (res.ok) setView(body);
      else setError(body.error ?? `HTTP ${res.status}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-5 text-amber-600" />
        <h1 className="text-lg font-semibold">AI Agent 寫入審批</h1>
      </div>
      {!view && !error && <Loader2 className="mt-6 size-5 animate-spin text-muted-foreground" />}
      {error && <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {view && (
        <div className="mt-4 space-y-4 text-sm">
          <div className="rounded-lg border p-4 space-y-2">
            <p><span className="text-muted-foreground">送出者：</span>{view.requester}</p>
            <p><span className="text-muted-foreground">動作：</span>{view.summary}</p>
            <p><span className="text-muted-foreground">風險：</span>{view.risk === "high" ? "高（需主管核准）" : "低"}</p>
            <p><span className="text-muted-foreground">送出時間：</span>{time(view.createdAt)}</p>
            <p>
              <span className="text-muted-foreground">狀態：</span>
              <span className="font-medium">{STATUS[view.status]}</span>
            </p>
            <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
              {view.codeMode ? String(view.args.code ?? "") : JSON.stringify(view.args, null, 2)}
            </pre>
          </div>

          {view.canDecide && (
            <div className="flex gap-3">
              <button
                onClick={() => void decide("approve")}
                disabled={busy}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-foreground px-4 py-2.5 text-background disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 核准
              </button>
              <button
                onClick={() => void decide("reject")}
                disabled={busy}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-4 py-2.5 disabled:opacity-50"
              >
                <X className="size-4" /> 拒絕
              </button>
            </div>
          )}

          {view.events.length > 0 && (
            <ol className="space-y-1 border-l pl-3 text-muted-foreground">
              {view.events.map((e, i) => (
                <li key={i}><span className="tabular-nums">{time(e.at)}</span> {e.label}</li>
              ))}
            </ol>
          )}
          {view.status === "done" && view.result != null && (
            <pre className="max-h-60 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
              {typeof view.result === "string" ? view.result : JSON.stringify(view.result, null, 2)}
            </pre>
          )}
          {view.error && <p className="text-destructive break-words">{view.error}</p>}
          {view.workflowUrl && (
            <a href={view.workflowUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:underline">
              <ExternalLink className="size-3.5" /> 在 Cloudflare 查看 Workflow
            </a>
          )}
        </div>
      )}
    </main>
  );
}
