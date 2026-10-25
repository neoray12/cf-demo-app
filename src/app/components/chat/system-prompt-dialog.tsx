'use client';

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { HarnessSection } from "@/lib/system-prompt";

interface PromptState {
  prompt: string;
  isCustom: boolean;
  canSave: boolean;
  defaultPrompt: string;
  harnessSections: HarnessSection[];
  maxLength: number;
}

/**
 * Edit the main chat's base system prompt (saved per user). The sections the
 * harness appends — the safety rule and tool guidance — are shown read-only.
 */
export function SystemPromptDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<PromptState | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showHarness, setShowHarness] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    fetch("/api/chat/system-prompt", { cache: "no-store" })
      .then((r) => r.json() as Promise<PromptState>)
      .then((data) => {
        setState(data);
        setDraft(data.prompt);
      })
      .catch(() => setError(t("chat.systemPrompt.loadError")));
  }, [open, t]);

  const call = async (method: "PUT" | "DELETE") => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/chat/system-prompt", {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ prompt: draft }) } : {}),
      });
      const data = (await res.json()) as { prompt?: string; isCustom?: boolean; error?: string };
      if (!res.ok) {
        setError(t(`chat.systemPrompt.errors.${data.error ?? "save"}`, { max: state?.maxLength }));
        return;
      }
      setDraft(data.prompt ?? draft);
      setState((s) => (s ? { ...s, prompt: data.prompt ?? draft, isCustom: Boolean(data.isCustom) } : s));
      setSaved(true);
    } catch {
      setError(t("chat.systemPrompt.errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const tooLong = state ? draft.length > state.maxLength : false;
  const dirty = state ? draft !== state.prompt : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90svh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("chat.systemPrompt.title")}</DialogTitle>
          <DialogDescription>{t("chat.systemPrompt.description")}</DialogDescription>
        </DialogHeader>

        {!state ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            {error ? <span className="text-destructive text-sm">{error}</span> : <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`rounded px-1.5 py-0.5 ${state.isCustom ? "bg-primary/10 text-primary" : "bg-muted"}`}>
                {state.isCustom ? t("chat.systemPrompt.custom") : t("chat.systemPrompt.default")}
              </span>
              {!state.canSave && <span>{t("chat.systemPrompt.signInToSave")}</span>}
              <span className={`ml-auto tabular-nums ${tooLong ? "text-destructive" : ""}`}>
                {draft.length.toLocaleString("en-US")} / {state.maxLength.toLocaleString("en-US")}
              </span>
            </div>
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
              }}
              rows={18}
              spellCheck={false}
              className="w-full min-h-[18rem] shrink-0 resize-y rounded-lg border bg-muted/20 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:border-foreground/30"
            />
            <div>
              <button
                onClick={() => setShowHarness((v) => !v)}
                aria-expanded={showHarness}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronRight className={`size-3 transition-transform ${showHarness ? "rotate-90" : ""}`} />
                {t("chat.systemPrompt.harnessTitle")}
              </button>
              {showHarness && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-muted-foreground">{t("chat.systemPrompt.harnessHint")}</p>
                  {state.harnessSections.map((s) => (
                    <div key={s.id} className="rounded-lg border bg-muted/30 p-2.5">
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t(`chat.systemPrompt.harness.${s.id}`)}</div>
                      <p className="whitespace-pre-wrap text-xs leading-relaxed">{s.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {state && (
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <div className="text-xs">
              {error && <span className="text-destructive">{error}</span>}
              {saved && !error && <span className="text-emerald-600 dark:text-emerald-400">{t("chat.systemPrompt.saved")}</span>}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => (state.isCustom ? call("DELETE") : setDraft(state.defaultPrompt))}
                disabled={busy || !state.canSave}
                className="h-8 rounded-lg border px-3 text-xs hover:bg-muted/60 disabled:opacity-50"
              >
                {t("chat.systemPrompt.reset")}
              </button>
              <button
                onClick={() => call("PUT")}
                disabled={busy || !state.canSave || !dirty || tooLong || !draft.trim()}
                className="h-8 rounded-lg bg-foreground px-4 text-xs font-medium text-background hover:bg-foreground/80 disabled:opacity-40"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : t("chat.systemPrompt.save")}
              </button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
