'use client';

import { useTranslation } from "react-i18next";
import { compareRuns, type CompareRow } from "@/lib/experiment-compare";
import type { TraceSummary } from "@/lib/trace-summary";

const fmt = (row: CompareRow, v: number | null) =>
  v === null ? "–" : row.key === "totalMs" || row.key === "ttftMs" ? `${(v / 1000).toFixed(1)} s` : v.toLocaleString("en-US");

/** Without vs with Code Mode for one comparison example. */
export function CompareTable({ id, off, on }: { id: string; off: TraceSummary | null; on: TraceSummary | null }) {
  const { t } = useTranslation();
  const rows = compareRuns(off, on);
  return (
    <div className="mt-3 max-w-xl overflow-x-auto rounded-lg border">
      <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium">{t("chat.compare.title", { id })}</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-normal">{t("chat.compare.metric")}</th>
            <th className="px-3 py-1.5 text-right font-normal">{t("chat.compare.off")}</th>
            <th className="px-3 py-1.5 text-right font-normal">{t("chat.compare.on")}</th>
            <th className="px-3 py-1.5 text-right font-normal">{t("chat.compare.delta")}</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((row) => (
            <tr key={row.key} className="border-t">
              <td className="px-3 py-1.5">{t(`chat.compare.rows.${row.key}`)}</td>
              <td className="px-3 py-1.5 text-right">{off ? fmt(row, row.off) : t("chat.compare.failed")}</td>
              <td className="px-3 py-1.5 text-right">{on ? fmt(row, row.on) : t("chat.compare.failed")}</td>
              <td
                className={`px-3 py-1.5 text-right ${
                  row.deltaPct === null ? "" : row.deltaPct < 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                }`}
              >
                {row.deltaPct === null ? "–" : `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
