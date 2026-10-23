// Pure helpers for the Agents UI (KB workspace, Radar charts, grounding badge). No React, no server imports.
import type { ChartEvent } from "./trace-events";
import type { RunTrace } from "./trace-tree";

// ---------------------------------------------------------------------------
// KB indexing status

export type IndexState = "indexing" | "done" | "failed" | "unknown";

export interface KbStatusFile {
  key: string;
  status: string;
  error?: string;
}

/**
 * Display state of one document. AI Search per-file status is only a hint (an item can stay `running` long after
 * it is searchable), so: queued/running -> indexing, completed -> done, error -> failed, and a document that is
 * absent from the status list (or has an unrecognised status) is "unknown", never "failed".
 */
export function indexState(file: Pick<KbStatusFile, "status"> | undefined): IndexState {
  if (!file) return "unknown";
  switch (file.status) {
    case "queued":
    case "running":
      return "indexing";
    case "completed":
      return "done";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

export interface IndexSummary {
  indexing: number;
  done: number;
  failed: number;
  unknown: number;
  /** Polling can stop: there are documents and every one of them is completed or error. */
  settled: boolean;
}

export function summarizeIndex(docKeys: string[], files: KbStatusFile[]): IndexSummary {
  const byKey = new Map(files.map((f) => [f.key, f]));
  const out: IndexSummary = { indexing: 0, done: 0, failed: 0, unknown: 0, settled: false };
  for (const key of docKeys) out[indexState(byKey.get(key))]++;
  // A freshly uploaded document is not in the status list until the sync job picks it up, so "unknown" keeps polling.
  out.settled = docKeys.length > 0 && out.indexing === 0 && out.unknown === 0;
  return out;
}

export const STATUS_POLL_BASE_MS = 10_000;
export const STATUS_POLL_CAP_MS = 60_000;

/** Delay before status poll round `round` (0-based) while files are unsettled: 10 s → 20 s → 40 s → 60 s (cap). */
export function statusPollDelay(round: number): number {
  const r = Math.max(0, Math.trunc(round) || 0);
  return Math.min(STATUS_POLL_CAP_MS, STATUS_POLL_BASE_MS * 2 ** Math.min(r, 10));
}

/**
 * Whether the workspace status poll should keep going after a round: never for the read-only sample or an empty
 * workspace (an upload / import restarts it), never once every document has a final status; a failed round
 * (no doc list or no status) keeps polling.
 */
export function shouldKeepPolling(o: {
  writable: boolean;
  docKeys: string[] | null;
  files: KbStatusFile[] | null;
}): boolean {
  if (!o.writable) return false;
  if (o.docKeys !== null && o.docKeys.length === 0) return false;
  if (o.docKeys === null || o.files === null) return true;
  return !summarizeIndex(o.docKeys, o.files).settled;
}

/** `ws-abcd1234/site/example-com/index.md` -> `site/example-com/index.md` */
export function docDisplayName(workspace: string, key: string): string {
  const prefix = `${workspace}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** Error bodies are `{ error: "agents.kb.errors.<key>" }`; anything else falls back to the generic server key. */
export function kbErrorKey(body: unknown): string {
  const e = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof e === "string" && /^agents\.kb\.errors\.[A-Za-z]+$/.test(e) ? e : "agents.kb.errors.server";
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Radar charts

export type RadarChartData = ChartEvent["chart"];

export interface ChartRow {
  label: string;
  value: number;
  previous?: number;
}

/** Rows with finite numbers only; `previous` is kept only when present (absent last week is not 0). */
export function chartRows(chart: Pick<RadarChartData, "data">): ChartRow[] {
  const rows: ChartRow[] = [];
  for (const d of chart.data) {
    if (!Number.isFinite(d.value)) continue;
    rows.push(
      d.previous !== undefined && Number.isFinite(d.previous)
        ? { label: d.label, value: d.value, previous: d.previous }
        : { label: d.label, value: d.value },
    );
  }
  return rows;
}

export function chartHasPrevious(rows: ChartRow[]): boolean {
  return rows.some((r) => r.previous !== undefined);
}

/** Axis / tooltip text for a value of the given Radar unit. */
export function formatChartValue(unit: string, v: number): string {
  switch (unit) {
    case "percent":
      return `${v.toFixed(v >= 10 ? 1 : 2)}%`;
    case "normalized":
      return v.toFixed(2);
    case "mbps":
      return `${v.toFixed(1)} Mbps`;
    case "ms":
      return `${v.toFixed(1)} ms`;
    case "rank":
      return `#${Math.round(v)}`;
    default:
      return String(Math.round(v * 100) / 100);
  }
}

export const isHttpUrl = (u: string | undefined): u is string => !!u && /^https?:\/\//i.test(u);

export function truncateLabel(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

// ---------------------------------------------------------------------------
// Grounding (citation check)

export type Grounding =
  | { state: "checking" }
  | { state: "ok" }
  | { state: "unsupported"; sentences: string[] }
  | { state: "incomplete" };

/** Result of the `grounding-checker` subagent span under the root agent, or null when the run has none. */
export function groundingOf(trace: RunTrace | null | undefined): Grounding | null {
  if (!trace) return null;
  let node: RunTrace["spans"][string] | undefined;
  for (const n of Object.values(trace.spans)) {
    if (n.kind !== "invoke_agent" || n.name !== "grounding-checker" || n.parentId !== trace.runId) continue;
    if (!node || n.start >= node.start) node = n;
  }
  if (!node) return null;
  if (node.end === null) return { state: "checking" };
  if (node.status === "error") return { state: "incomplete" };
  const detail = node.detail as { unsupported?: unknown; parseError?: unknown } | null | undefined;
  if (!detail || typeof detail !== "object" || detail.parseError === true || !Array.isArray(detail.unsupported)) {
    return { state: "incomplete" };
  }
  const sentences = detail.unsupported
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.length === 0 ? { state: "ok" } : { state: "unsupported", sentences };
}

// ---------------------------------------------------------------------------
// Sources

export interface SourceGroup<T> {
  /** Original 1-based citation numbers (the `[n]` the answer uses); repeated hits of one source share a group. */
  ns: number[];
  source: T;
}

/**
 * Collapses repeated sources (same URL, or same title+snippet) while keeping EVERY original number, so an answer
 * citing [4] (the same document found again by a second search) still finds its entry as `[1][4]`.
 */
export function groupSources<T extends { title: string; url?: string; snippet: string }>(
  citations: T[],
): Array<SourceGroup<T>> {
  const byKey = new Map<string, SourceGroup<T>>();
  citations.forEach((c, i) => {
    const key = c.url ?? `${c.title}\n${c.snippet}`;
    const hit = byKey.get(key);
    if (hit) hit.ns.push(i + 1);
    else byKey.set(key, { ns: [i + 1], source: c });
  });
  return [...byKey.values()];
}
