"use client";

import { useTranslation } from "react-i18next";
import { Box, MapPin, Clock, Snowflake, Flame } from "lucide-react";
import { getColoInfo, type ColoInfo } from "@/lib/colo-locations";
import { WORLD_MAP_PATH } from "@/lib/world-map-path";

export interface SandboxTelemetry {
  sandboxId: string;
  containerId: string | null;
  colo: string | null;
  uptimeSeconds: number | null;
  coldStart: boolean | null;
}

// Container ID / POP / uptime / cold-warm — the four data points that make
// "this ran in a real, isolated container somewhere on Cloudflare's network"
// concrete instead of abstract, for customer demos.
export function SandboxInfoBar({ sandbox }: { sandbox: SandboxTelemetry | null | undefined }) {
  const { t } = useTranslation();
  if (!sandbox) return null;
  const { sandboxId, containerId, colo, uptimeSeconds, coldStart } = sandbox;
  if (!sandboxId && !colo && uptimeSeconds == null) return null;

  const coloInfo = getColoInfo(colo);
  const coloText = coloInfo ? `${coloInfo.city} (${coloInfo.code})` : colo || t("chat.sandbox.unknownColo");

  const uptimeText =
    uptimeSeconds == null
      ? t("chat.sandbox.uptimeUnknown")
      : uptimeSeconds < 2
        ? t("chat.sandbox.justStarted")
        : uptimeSeconds >= 60
          ? t("chat.sandbox.uptimeMinSec", { m: Math.floor(uptimeSeconds / 60), s: Math.floor(uptimeSeconds % 60) })
          : t("chat.sandbox.uptimeSec", { s: Math.floor(uptimeSeconds) });

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5 ml-3 text-[11px] text-muted-foreground">
      {sandboxId && (
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60 font-mono"
          title={containerId ? `${t("chat.sandbox.sandboxIdTooltip")} · container: ${containerId}` : t("chat.sandbox.sandboxIdTooltip")}
        >
          <Box className="size-3" />
          {sandboxId}
        </span>
      )}
      {colo && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60" title={t("chat.sandbox.popTooltip")}>
          <MapPin className="size-3" />
          {coloText}
        </span>
      )}
      {uptimeSeconds != null && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60" title={t("chat.sandbox.uptimeTooltip")}>
          <Clock className="size-3" />
          {uptimeText}
        </span>
      )}
      {coldStart != null && (
        <span
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md ${
            coldStart
              ? "bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-400"
              : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
          }`}
          title={coldStart ? t("chat.sandbox.coldStartTooltip") : t("chat.sandbox.warmStartTooltip")}
        >
          {coldStart ? <Snowflake className="size-3" /> : <Flame className="size-3" />}
          {coldStart ? t("chat.sandbox.coldStart") : t("chat.sandbox.warmStart")}
        </span>
      )}
    </div>
  );
}

// Cropped to APAC, not the whole globe — the chat-sandbox container is
// pinned to constraints.regions=["APAC"] (wrangler.toml) and demo traffic
// is Taiwan-based, so a full world map is mostly empty ocean. Bounds cover
// India through Japan with margin (Oceania is a separate Containers region
// from APAC, so it's deliberately excluded).
const MAP_MIN_LON = 65;
const MAP_MAX_LON = 150;
const MAP_MIN_LAT = -15;
const MAP_MAX_LAT = 48;

function project(lat: number, lon: number) {
  return { x: lon, y: -lat };
}

function projectPct(lat: number, lon: number) {
  const xPct = ((lon - MAP_MIN_LON) / (MAP_MAX_LON - MAP_MIN_LON)) * 100;
  const yPct = ((MAP_MAX_LAT - lat) / (MAP_MAX_LAT - MAP_MIN_LAT)) * 100;
  // Clamp so a colo outside the APAC crop (shouldn't happen given the
  // region pin, but cheap insurance) still renders at the map's edge
  // instead of drifting off the visible card.
  return { xPct: Math.min(100, Math.max(0, xPct)), yPct: Math.min(100, Math.max(0, yPct)) };
}

function PopPin({
  info,
  pct,
  dotClass,
  label,
}: {
  info: ColoInfo;
  pct: { xPct: number; yPct: number };
  dotClass: string;
  label: string;
}) {
  // Anchor the label so it never spills past the map edge: near the right
  // edge, grow leftward from the pin; near the left edge, grow rightward;
  // otherwise center. (left-0/right-0 wouldn't work here — the label's
  // positioning parent is the pin's own near-zero-width wrapper, not the
  // map, so the anchor has to come from the translate instead.)
  const labelTranslateClass = pct.xPct > 70 ? "-translate-x-[calc(100%-4px)]" : pct.xPct < 30 ? "translate-x-[-4px]" : "-translate-x-1/2";

  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${pct.xPct}%`, top: `${pct.yPct}%` }}
    >
      <span className={`absolute inset-0 -m-1 rounded-full ${dotClass} opacity-50 animate-ping`} />
      <span className={`relative block size-2 rounded-full ${dotClass} ring-2 ring-white/90`} />
      <div
        className={`absolute top-3 left-0 ${labelTranslateClass} whitespace-nowrap text-[9px] leading-tight px-1.5 py-0.5 rounded bg-black/75 text-white`}
      >
        <span className="font-medium">{label}</span>
        <span className="text-white/70"> · {info.city} ({info.code})</span>
      </div>
    </div>
  );
}

// World map showing where the chat request landed (edge POP) vs. where the
// sandbox container actually executed — the two are often different colos,
// which is the point: compute runs distributed across Cloudflare's network.
export function PopMap({
  edgeColo,
  sandboxColo,
}: {
  edgeColo?: string | null;
  sandboxColo?: string | null;
}) {
  const { t } = useTranslation();
  const edge = getColoInfo(edgeColo);
  const sandbox = getColoInfo(sandboxColo);
  if (!edge && !sandbox) return null;

  const sameLocation = Boolean(edge && sandbox && edge.code === sandbox.code);

  return (
    <div className="relative mt-2 ml-3 w-full max-w-sm aspect-[4/3] rounded-lg overflow-hidden bg-zinc-950 border border-zinc-700/50">
      <svg
        viewBox={`${MAP_MIN_LON} ${-MAP_MAX_LAT} ${MAP_MAX_LON - MAP_MIN_LON} ${MAP_MAX_LAT - MAP_MIN_LAT}`}
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 w-full h-full"
      >
        {/* Stroke widths are in viewBox degrees — thinner than the old
            full-world map since the same width now covers far fewer
            degrees (85° vs 360°), so a naive 0.5 would render ~4x thicker. */}
        <path d={WORLD_MAP_PATH} fill="#27272a" stroke="#3f3f46" strokeWidth={0.15} />
        {edge && sandbox && !sameLocation && (
          <line
            x1={project(edge.lat, edge.lon).x}
            y1={project(edge.lat, edge.lon).y}
            x2={project(sandbox.lat, sandbox.lon).x}
            y2={project(sandbox.lat, sandbox.lon).y}
            stroke="#38bdf8"
            strokeOpacity={0.6}
            strokeWidth={0.2}
            strokeDasharray="0.7,0.5"
          />
        )}
      </svg>
      {edge && (
        <PopPin
          info={edge}
          pct={projectPct(edge.lat, edge.lon)}
          dotClass="bg-sky-400"
          label={sameLocation ? t("chat.sandbox.edgePlusSandbox") : t("chat.sandbox.edgePop")}
        />
      )}
      {sandbox && !sameLocation && (
        <PopPin
          info={sandbox}
          pct={projectPct(sandbox.lat, sandbox.lon)}
          dotClass="bg-emerald-400"
          label={t("chat.sandbox.sandboxContainer")}
        />
      )}
    </div>
  );
}
