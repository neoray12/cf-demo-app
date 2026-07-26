"use client";

import { Box, MapPin, Clock, Snowflake, Flame } from "lucide-react";
import { getColoInfo, type ColoInfo } from "@/lib/colo-locations";
import { WORLD_MAP_PATH } from "@/lib/world-map-path";

export interface SandboxTelemetry {
  containerId: string | null;
  colo: string | null;
  uptimeSeconds: number | null;
  coldStart: boolean | null;
}

function formatUptime(seconds: number | null): string {
  if (seconds == null) return "未知";
  if (seconds < 2) return "剛啟動";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `已運行 ${m} 分 ${s} 秒` : `已運行 ${s} 秒`;
}

function coloLabel(code: string | null): string {
  const info = getColoInfo(code);
  if (!info) return code || "未知";
  return `${info.city} (${info.code})`;
}

// Container ID / POP / uptime / cold-warm — the four data points that make
// "this ran in a real, isolated container somewhere on Cloudflare's network"
// concrete instead of abstract, for customer demos.
export function SandboxInfoBar({ sandbox }: { sandbox: SandboxTelemetry | null | undefined }) {
  if (!sandbox) return null;
  const { containerId, colo, uptimeSeconds, coldStart } = sandbox;
  if (!containerId && !colo && uptimeSeconds == null) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5 ml-3 text-[11px] text-muted-foreground">
      {containerId && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60 font-mono" title="Container hostname">
          <Box className="size-3" />
          {containerId}
        </span>
      )}
      {colo && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60" title="Sandbox 容器所在的 Cloudflare 資料中心">
          <MapPin className="size-3" />
          {coloLabel(colo)}
        </span>
      )}
      {uptimeSeconds != null && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60" title="容器存活時間">
          <Clock className="size-3" />
          {formatUptime(uptimeSeconds)}
        </span>
      )}
      {coldStart != null && (
        <span
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md ${
            coldStart
              ? "bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-400"
              : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
          }`}
          title={coldStart ? "全新啟動的容器" : "重複使用既有容器"}
        >
          {coldStart ? <Snowflake className="size-3" /> : <Flame className="size-3" />}
          {coldStart ? "冷啟動" : "已預熱"}
        </span>
      )}
    </div>
  );
}

function project(lat: number, lon: number) {
  return { x: lon, y: -lat };
}

function projectPct(lat: number, lon: number) {
  return { xPct: ((lon + 180) / 360) * 100, yPct: ((90 - lat) / 180) * 100 };
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
  const edge = getColoInfo(edgeColo);
  const sandbox = getColoInfo(sandboxColo);
  if (!edge && !sandbox) return null;

  const sameLocation = Boolean(edge && sandbox && edge.code === sandbox.code);

  return (
    <div className="relative mt-2 ml-3 w-full max-w-sm aspect-[2/1] rounded-lg overflow-hidden bg-zinc-950 border border-zinc-700/50">
      <svg
        viewBox="-180 -90 360 180"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 w-full h-full"
      >
        <path d={WORLD_MAP_PATH} fill="#27272a" stroke="#3f3f46" strokeWidth={0.5} />
        {edge && sandbox && !sameLocation && (
          <line
            x1={project(edge.lat, edge.lon).x}
            y1={project(edge.lat, edge.lon).y}
            x2={project(sandbox.lat, sandbox.lon).x}
            y2={project(sandbox.lat, sandbox.lon).y}
            stroke="#38bdf8"
            strokeOpacity={0.6}
            strokeWidth={0.6}
            strokeDasharray="2,1.5"
          />
        )}
      </svg>
      {edge && (
        <PopPin
          info={edge}
          pct={projectPct(edge.lat, edge.lon)}
          dotClass="bg-sky-400"
          label={sameLocation ? "邊緣節點 + Sandbox" : "邊緣節點 (POP)"}
        />
      )}
      {sandbox && !sameLocation && (
        <PopPin
          info={sandbox}
          pct={projectPct(sandbox.lat, sandbox.lon)}
          dotClass="bg-emerald-400"
          label="Sandbox 容器"
        />
      )}
    </div>
  );
}
