'use client';

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Route } from "lucide-react";
import { ROUTING_REASONS, type AutoRouting } from "@/lib/auto-router";

type Routed = Pick<AutoRouting, "model" | "reason"> & Partial<Omit<AutoRouting, "model" | "reason">>;

/**
 * Auto Router decision for one answer: the chosen model, why (reason code +
 * explanation), the candidate pool and the IDs to find it in AI Gateway logs.
 * AI Gateway doesn't expose per-model scores, and the card says so.
 */
export function AutoRouterCard({ routed }: { routed: Routed }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const known = routed.reason && (ROUTING_REASONS as readonly string[]).includes(routed.reason);
  const reasonLabel = known ? t(`chat.autoRouter.reasons.${routed.reason}.label`) : (routed.reason ?? t("chat.autoRouter.noReason"));

  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );

  return (
    <div className="mb-1.5 max-w-xl">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-400 border border-orange-200/60 dark:border-orange-800/40 hover:bg-orange-100/70 dark:hover:bg-orange-950/50 transition-colors"
      >
        <Route className="size-3 shrink-0" />
        <span className="truncate">
          Auto Router → <span className="font-mono">{routed.model}</span> · {reasonLabel}
        </span>
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs">
          {row(t("chat.autoRouter.model"), <span className="font-mono">{routed.model}</span>)}
          {row(
            t("chat.autoRouter.reason"),
            <>
              <span className="font-medium">{reasonLabel}</span>
              {routed.reason && <span className="ml-1 font-mono text-muted-foreground">({routed.reason})</span>}
              {known && <p className="mt-0.5 text-muted-foreground">{t(`chat.autoRouter.reasons.${routed.reason}.desc`)}</p>}
            </>,
          )}
          {row(
            t("chat.autoRouter.pool"),
            routed.allowedProviders?.length ? routed.allowedProviders.join(", ") : t("chat.autoRouter.defaultPool"),
          )}
          {routed.decisionId && row(t("chat.autoRouter.decisionId"), <span className="font-mono">{routed.decisionId}</span>)}
          {routed.logId && row(t("chat.autoRouter.logId"), <span className="font-mono">{routed.logId}</span>)}
          <p className="pt-1 text-[11px] text-muted-foreground">{t("chat.autoRouter.noScores")}</p>
        </div>
      )}
    </div>
  );
}
