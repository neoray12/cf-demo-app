'use client';

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AutoRouterModel } from "@/lib/auto-router-models";

interface ModelsState {
  catalog: AutoRouterModel[];
  availableProviders: string[];
  defaultModels: string[] | null;
  selected: string[] | null;
  effective: string[] | null;
  canSave: boolean;
}

/**
 * Pick the models Auto Router may choose from (cf-aig-allowed-models), saved
 * per user; without a saved list the wrangler default applies. Providers this
 * gateway has no key or credits for are shown but can't be picked.
 */
export function AutoRouterModelsDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (effective: string[] | null) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ModelsState | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    fetch("/api/chat/auto-router-models", { cache: "no-store" })
      .then((r) => r.json() as Promise<ModelsState>)
      .then((data) => {
        setState(data);
        setPicked(data.effective ?? []);
      })
      .catch(() => setError(t("chat.autoRouterModels.errors.save")));
  }, [open, t]);

  const groups = useMemo(() => {
    const out = new Map<string, AutoRouterModel[]>();
    for (const m of state?.catalog ?? []) out.set(m.provider, [...(out.get(m.provider) ?? []), m]);
    return [...out.entries()];
  }, [state]);

  const toggle = (id: string) => {
    setSaved(false);
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const call = async (method: "PUT" | "DELETE") => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/chat/auto-router-models", {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ models: picked }) } : {}),
      });
      const data = (await res.json()) as { selected?: string[] | null; effective?: string[] | null; error?: string; models?: string[] };
      if (!res.ok) {
        setError(t(`chat.autoRouterModels.errors.${data.error ?? "save"}`, { models: data.models?.join(", ") ?? "" }));
        return;
      }
      setState((s) => (s ? { ...s, selected: data.selected ?? null, effective: data.effective ?? null } : s));
      setPicked(data.effective ?? []);
      setSaved(true);
      onSaved?.(data.effective ?? null);
    } catch {
      setError(t("chat.autoRouterModels.errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const usable = (m: AutoRouterModel) => state?.availableProviders.includes(m.provider) ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90svh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("chat.autoRouterModels.title")}</DialogTitle>
          <DialogDescription>{t("chat.autoRouterModels.description")}</DialogDescription>
        </DialogHeader>

        {!state ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            {error ? <span className="text-destructive text-sm">{error}</span> : <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : (
          <div className="min-h-0 space-y-4 overflow-y-auto">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className={`rounded px-1.5 py-0.5 ${state.selected ? "bg-primary/10 text-primary" : "bg-muted"}`}>
                {state.selected ? t("chat.autoRouterModels.usingCustom") : t("chat.autoRouterModels.usingDefault")}
              </span>
              <span>{t("chat.autoRouterModels.count", { n: picked.length })}</span>
              {!state.canSave && <span>{t("chat.autoRouterModels.signInToSave")}</span>}
              <button
                onClick={() => {
                  setSaved(false);
                  setPicked(state.catalog.filter(usable).map((m) => m.id));
                }}
                className="ml-auto rounded border px-2 py-0.5 hover:bg-muted/60"
              >
                {t("chat.autoRouterModels.selectAll")}
              </button>
            </div>
            {groups.map(([provider, models]) => {
              const available = state.availableProviders.includes(provider);
              return (
                <div key={provider}>
                  <div className="mb-1.5 flex items-baseline gap-2 text-xs">
                    <span className="font-medium">{provider}</span>
                    {!available && <span className="text-muted-foreground">{t("chat.autoRouterModels.providerUnavailable")}</span>}
                  </div>
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {models.map((m) => (
                      <label
                        key={m.id}
                        className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${
                          available ? "cursor-pointer hover:bg-muted/50" : "cursor-not-allowed opacity-50"
                        }`}
                      >
                        <input type="checkbox" checked={picked.includes(m.id)} disabled={!available} onChange={() => toggle(m.id)} />
                        <span className="min-w-0">
                          <span className="block truncate">{m.label}</span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">{m.id}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {state && (
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <div className="text-xs">
              {error && <span className="text-destructive">{error}</span>}
              {saved && !error && <span className="text-emerald-600 dark:text-emerald-400">{t("chat.autoRouterModels.saved")}</span>}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => (state.selected ? call("DELETE") : setPicked(state.defaultModels ?? []))}
                disabled={busy || !state.canSave}
                className="h-8 rounded-lg border px-3 text-xs hover:bg-muted/60 disabled:opacity-50"
              >
                {t("chat.autoRouterModels.useDefault")}
              </button>
              <button
                onClick={() => call("PUT")}
                disabled={busy || !state.canSave || picked.length === 0}
                className="h-8 rounded-lg bg-foreground px-4 text-xs font-medium text-background hover:bg-foreground/80 disabled:opacity-40"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : t("chat.autoRouterModels.save")}
              </button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
