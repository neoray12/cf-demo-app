"use client";

import { useTranslation } from "react-i18next";
import { Network } from "lucide-react";
import { summarizeEgress, type EgressAction, type EgressEvent } from "@/lib/sandbox-egress";

const ACTION_STYLE: Record<EgressAction, { row: string; badge: string; mark: string }> = {
  allowed: { row: "text-muted-foreground", badge: "bg-muted text-muted-foreground", mark: "" },
  injected: {
    row: "text-emerald-700 dark:text-emerald-400",
    badge: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
    mark: "🔑 ",
  },
  blocked: {
    row: "text-red-600 dark:text-red-400",
    badge: "bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-400",
    mark: "🛡 ",
  },
};

// Sandbox egress decisions for one executeCode run: every outbound HTTP(S)
// request the code made went through the Worker's policy. Shows only
// method / host / path / status — the injected token never reaches the app.
export function EgressLog({ events }: { events: EgressEvent[] | null | undefined }) {
  const { t } = useTranslation();
  if (!events || events.length === 0) return null;
  const counts = summarizeEgress(events);

  return (
    <div className="mt-1.5 ml-3 rounded-lg border border-border/60 overflow-hidden text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 bg-muted/40" title={t("chat.egress.tooltip")}>
        <Network className="size-3 text-muted-foreground" />
        <span className="font-medium text-foreground">{t("chat.egress.title")}</span>
        {(["allowed", "injected", "blocked"] as const)
          .filter((a) => counts[a] > 0)
          .map((a) => (
            <span key={a} className={`px-1.5 py-0.5 rounded ${ACTION_STYLE[a].badge}`}>
              {ACTION_STYLE[a].mark}
              {t(`chat.egress.${a}`)} {counts[a]}
            </span>
          ))}
      </div>
      <div className="max-h-[180px] overflow-y-auto">
        <table className="w-full font-mono">
          <tbody>
            {events.map((e, i) => (
              <tr key={i} data-egress-action={e.action} className={`border-t border-border/40 ${ACTION_STYLE[e.action].row}`}>
                <td className="px-3 py-1 whitespace-nowrap">{e.method}</td>
                <td className="px-1 py-1 break-all">
                  {e.host}
                  <span className="opacity-70">{e.path}</span>
                </td>
                <td className="px-1 py-1 whitespace-nowrap text-right">{e.status ?? "—"}</td>
                <td className="px-3 py-1 whitespace-nowrap text-right">
                  {ACTION_STYLE[e.action].mark}
                  {t(`chat.egress.${e.action}`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
