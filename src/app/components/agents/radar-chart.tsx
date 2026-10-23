'use client';

import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ExternalLink } from "lucide-react";
import {
  chartHasPrevious,
  chartRows,
  formatChartValue,
  isHttpUrl,
  truncateLabel,
  type RadarChartData,
} from "@/lib/agents/ui-helpers";

// Theme colours come from the app's CSS variables (globals.css), so light and dark mode both stay readable.
const CURRENT = "var(--chart-2)";
const PREVIOUS = "var(--muted-foreground)";
const AXIS = "var(--muted-foreground)";
const GRID = "var(--border)";
const AXIS_TICK = { fill: AXIS, fontSize: 11 };
const TOOLTIP_STYLE = {
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
};
const LABEL_MAX = 16;
const BAR_PX = 22;

/** Axis caption: `normalized` is a 0-1 relative value, not a count; other units are shown as Radar means them. */
function useUnitLabel(unit: string): string {
  const { t } = useTranslation();
  const known = ["percent", "normalized", "mbps", "ms", "rank", "events"];
  return known.includes(unit) ? t(`agents.chart.unit.${unit}`) : unit;
}

/**
 * One Radar result: horizontal bars (`bar`, with a lighter "last week" bar when `previous` is present) or a line
 * (`line`, used for 0-1 normalized time series), with title, period, unit note and a link to the source page.
 */
export const RadarChart = memo(function RadarChart({ chart }: { chart: RadarChartData }) {
  const { t } = useTranslation();
  const rows = useMemo(() => chartRows(chart), [chart]);
  const compared = chartHasPrevious(rows);
  const unitLabel = useUnitLabel(chart.unit);
  const fmt = (v: unknown) => (typeof v === "number" ? formatChartValue(chart.unit, v) : String(v ?? ""));
  const thisPeriod = t("agents.chart.thisPeriod");
  const lastWeek = t("agents.chart.lastWeek");

  const barHeight = Math.max(150, rows.length * (compared ? BAR_PX * 2 + 10 : BAR_PX + 12) + 36);

  return (
    <figure className="min-w-0 rounded-xl border bg-card p-3 text-card-foreground">
      <figcaption className="mb-2 flex flex-col gap-0.5">
        <span className="text-sm font-medium leading-snug">{chart.title}</span>
        <span className="text-[11px] text-muted-foreground">
          {t("agents.chart.period", { period: chart.period })} · {unitLabel}
          {compared && ` · ${t("agents.chart.compared")}`}
        </span>
      </figcaption>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t("agents.chart.noData")}</p>
      ) : chart.kind === "line" ? (
        <div role="img" aria-label={chart.title} style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} stroke={GRID} tickMargin={4} />
              <YAxis tick={AXIS_TICK} stroke={GRID} tickFormatter={(v) => formatChartValue(chart.unit, Number(v))} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ stroke: GRID }}
                formatter={(v) => [fmt(v), thisPeriod]}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="value"
                name={thisPeriod}
                stroke={CURRENT}
                strokeWidth={2}
                dot={{ r: 3, fill: CURRENT, stroke: CURRENT }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div role="img" aria-label={chart.title} style={{ height: barHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barGap={2}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={AXIS_TICK} stroke={GRID} tickFormatter={(v) => formatChartValue(chart.unit, Number(v))} />
              <YAxis
                type="category"
                dataKey="label"
                width={104}
                tick={AXIS_TICK}
                stroke={GRID}
                interval={0}
                tickFormatter={(v) => truncateLabel(String(v), LABEL_MAX)}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                formatter={(v, name) => [fmt(v), name]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="value"
                name={thisPeriod}
                fill={CURRENT}
                radius={[0, 3, 3, 0]}
                barSize={compared ? BAR_PX - 6 : BAR_PX - 4}
                isAnimationActive={false}
              />
              {compared && (
                <Bar
                  dataKey="previous"
                  name={lastWeek}
                  fill={PREVIOUS}
                  fillOpacity={0.45}
                  radius={[0, 3, 3, 0]}
                  barSize={BAR_PX - 6}
                  isAnimationActive={false}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {compared && (
        <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: CURRENT }} />
            {thisPeriod}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: PREVIOUS, opacity: 0.45 }} />
            {lastWeek}
          </span>
        </div>
      )}

      {isHttpUrl(chart.sourceUrl) && (
        <a
          href={chart.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("agents.chart.source")}
          <ExternalLink className="size-3" />
        </a>
      )}
    </figure>
  );
});
