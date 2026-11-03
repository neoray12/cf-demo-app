'use client';

import { useTranslation } from "react-i18next";
import { codeTimingRows, compareTimings, type CodeTimingRow } from "@/lib/code-timing";
import type { ToolCallInfo } from "@/lib/chat-turn";

const ms = (v: number) => `${v.toLocaleString("en-US")} ms`;
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US")} ms`;

/** The turn's code runs side by side, from the timings on their tool cards. */
export function CodeTimingTable({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const { t } = useTranslation();
  const rows = codeTimingRows(toolCalls);
  if (rows.length < 2 || !rows.some((r) => r.totalMs !== undefined)) return null;
  const cmp = compareTimings(rows);
  const cell = (row: CodeTimingRow, v: number | undefined) =>
    v === undefined ? "–" : `${row.estimated ? "≈ " : ""}${ms(v)}`;

  return (
    <div className="mt-3 max-w-2xl overflow-x-auto rounded-lg border">
      <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium">{t("chat.codeTiming.title")}</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-normal">{t("chat.codeTiming.env")}</th>
            <th className="px-3 py-1.5 text-left font-normal">{t("chat.codeTiming.code")}</th>
            <th className="px-3 py-1.5 text-right font-normal">{t("chat.codeTiming.total")}</th>
            <th className="px-3 py-1.5 text-right font-normal">{t("chat.codeTiming.exec")}</th>
            <th className="px-3 py-1.5 text-right font-normal">{t("chat.codeTiming.overhead")}</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="px-3 py-1.5 whitespace-nowrap">
                {t(`chat.codeTiming.envs.${row.env}`)}
                {row.baseline && <span className="ml-1 text-muted-foreground">· {t("chat.codeTiming.baseline")}</span>}
              </td>
              <td className="px-3 py-1.5 max-w-[16rem] truncate font-mono text-muted-foreground" title={row.code}>
                {row.code}
              </td>
              <td className="px-3 py-1.5 text-right font-medium">{row.totalMs === undefined ? "–" : ms(row.totalMs)}</td>
              <td className="px-3 py-1.5 text-right">{cell(row, row.execMs)}</td>
              <td className="px-3 py-1.5 text-right">{cell(row, row.overheadMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cmp && (
        <div className="border-t px-3 py-2 text-xs">
          {t(cmp.diffMs >= 0 ? "chat.codeTiming.slower" : "chat.codeTiming.faster", {
            diff: ms(Math.abs(cmp.diffMs)),
            ratio: cmp.diffMs >= 0 ? cmp.ratio : Math.round((cmp.dwMs / cmp.sandboxMs) * 10) / 10,
          })}
          {cmp.execDiffMs !== undefined && cmp.overheadDiffMs !== undefined && (
            <span className="text-muted-foreground">
              {t("chat.codeTiming.split", { exec: signed(cmp.execDiffMs), overhead: signed(cmp.overheadDiffMs) })}
            </span>
          )}
        </div>
      )}
      <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        {t("chat.codeTiming.note")}
        {rows.some((r) => r.env === "dynamic-worker") && ` ${t("chat.codeTiming.noteDw")}`}
        {rows.some((r) => r.env !== "dynamic-worker") && ` ${t("chat.codeTiming.noteSandbox")}`}
        {rows.some((r) => r.env === "dynamic-worker" && r.totalMs === undefined) && ` ${t("chat.codeTiming.missing")}`}
      </div>
    </div>
  );
}
