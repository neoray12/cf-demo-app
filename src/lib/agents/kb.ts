// Knowledge-base core: workspace ids, upload validation, and the AI Search / R2 REST calls.
// A workspace is a folder prefix (`default/`, `ws-xxxxxxxx/`) in the KB_BUCKET_NAME R2 bucket that is indexed
// by the KB_AI_SEARCH instance; searches are scoped to it with a folder filter.
import type { AgentEnv } from "./env";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const WORKSPACE_RE = /^(default|ws-[a-z0-9]{8})$/;
const MIN_SCORE = 0.3;
// Seed docs are 1.5-2k chars (one chunk each); a shorter snippet cut off facts that sit late in the document.
const SNIPPET_MAX = 3000;
const MAX_RESULTS_CAP = 10;
const SEARCH_TIMEOUT_MS = 20_000;
const API_TIMEOUT_MS = 15_000;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_WORKSPACE = 20;
const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".md", ".txt"];

export function isValidWorkspace(id: string): boolean {
  return WORKSPACE_RE.test(id);
}

export function newWorkspaceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `ws-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

/** Returns an i18n error key, or null when the file may be uploaded. */
export function validateUpload(file: { name: string; size: number }, existingCount: number): string | null {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext))) return "agents.kb.errors.badType";
  if (file.size > MAX_UPLOAD_BYTES) return "agents.kb.errors.tooLarge";
  if (existingCount >= MAX_FILES_PER_WORKSPACE) return "agents.kb.errors.tooMany";
  return null;
}

const NAME_MAX = 100;

/**
 * Sanitised object name for an uploaded file: the original basename with every character outside
 * `[A-Za-z0-9._-]` and CJK replaced by `_`. Returns null when nothing meaningful is left (empty stem).
 */
export function safeUploadName(original: string): string | null {
  const base = original.split(/[\\/]/).pop() ?? "";
  let name = base.replace(/[^A-Za-z0-9._\-\p{Script=Han}]/gu, "_").replace(/^\.+/, "");
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  let stem = dot > 0 ? name.slice(0, dot) : name;
  if (!/[A-Za-z0-9\p{Script=Han}]/u.test(stem)) return null;
  stem = Array.from(stem).slice(0, Math.max(1, NAME_MAX - ext.length)).join("");
  name = `${stem}${ext}`;
  return name;
}

/** `[a-z0-9-]` slug (max 80) of a URL's path; `index` when it is empty. */
export function slugFromUrl(url: string): string {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    // fall through to "index"
  }
  const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return slug || "index";
}

/** `[a-z0-9-]` slug of a URL's hostname (dots become `-`, max 80); `site` when it cannot be parsed. */
export function hostSlugFromUrl(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // fall through to "site"
  }
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return slug || "site";
}

/**
 * Number of files that count against MAX_FILES_PER_WORKSPACE: only top-level uploads. Everything under `site/`
 * (imported pages, which have their own 30-page-per-job cap) is excluded.
 */
export function countUploadedDocs(workspace: string, docs: Array<{ key: string }>): number {
  const sitePrefix = `${workspace}/site/`;
  return docs.filter((d) => !d.key.startsWith(sitePrefix)).length;
}

/**
 * Request body for AI Search. The folder filter uses the Vectorize-style format (verified in Task 1; the legacy
 * `{type,key,value}` filter is rejected with 7105): `$gte "<ws>/"` and `$lt "<ws>0"` ("0" is the character after "/")
 * select every key below that folder and nothing else.
 *
 * `query_rewrite.enabled: false`: the instance rewrites queries into English by default, which then scores below
 * the instance's 0.4 threshold against Chinese chunks ("出差住宿上限" -> 0 hits, 0.94 without the rewrite). The agent
 * already rewrites its own queries.
 */
export function kbSearchBody(workspace: string, query: string, maxResults: number): object {
  return {
    messages: [{ role: "user", content: query }],
    ai_search_options: {
      query_rewrite: { enabled: false },
      retrieval: {
        max_num_results: maxResults,
        filters: { folder: { $gte: `${workspace}/`, $lt: `${workspace}0` } },
      },
    },
  };
}

export interface KbSearchResult {
  filename: string;
  score: number;
  snippet: string;
  sourceUrl: string | null;
}

interface ApiEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

function apiError(res: Response, data: ApiEnvelope<unknown> | null): Error {
  const first = data?.errors?.[0];
  return new Error(`${first?.message ?? `HTTP ${res.status}`}${first?.code ? ` (${first.code})` : ""}`);
}

function assertWorkspace(workspace: string): void {
  if (!isValidWorkspace(workspace)) throw new Error(`invalid workspace: ${workspace}`);
}

export async function kbSearch(
  env: AgentEnv,
  workspace: string,
  query: string,
  maxResults = 5,
  signal?: AbortSignal,
): Promise<{ results: KbSearchResult[]; topScore: number }> {
  assertWorkspace(workspace);
  const limit = Math.min(Math.max(Math.trunc(maxResults) || 1, 1), MAX_RESULTS_CAP);
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const res = await fetch(
    `${API_BASE}/${env.CF_ACCOUNT_ID}/ai-search/namespaces/default/instances/${env.KB_AI_SEARCH}/search`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(kbSearchBody(workspace, query, limit)),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    },
  );
  const data = (await res.json().catch(() => null)) as ApiEnvelope<{
    chunks?: Array<{ score: number; text: string; item?: { key?: string; metadata?: { sourceurl?: string } } }>;
  }> | null;
  if (!res.ok || !data?.success) throw apiError(res, data);
  const results = (data.result?.chunks ?? [])
    .filter((c) => c.score >= MIN_SCORE)
    .map((c) => ({
      filename: c.item?.key ?? "",
      score: c.score,
      snippet: c.text.slice(0, SNIPPET_MAX),
      sourceUrl: c.item?.metadata?.sourceurl || null,
    }));
  return { results, topScore: results.reduce((m, r) => Math.max(m, r.score), 0) };
}

/** R2 REST list API maximum page size (per_page > 1000 → 10029 "per_page must be between 0 and 1000"). */
const R2_LIST_PER_PAGE = 1000;
const R2_LIST_MAX_PAGES = 5;

/**
 * Every object below `<workspace>/` in the KB bucket. The R2 REST list API pages with an opaque cursor:
 * `result_info: { cursor, is_truncated, per_page }` (result_info is null when everything fit in one page);
 * the next page is `?cursor=<cursor>`. Asks for 1000 per page and follows the cursor for at most 5 pages.
 */
export async function kbListDocs(
  env: AgentEnv,
  workspace: string,
): Promise<Array<{ key: string; size: number; uploaded: string }>> {
  assertWorkspace(workspace);
  const out: Array<{ key: string; size: number; uploaded: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < R2_LIST_MAX_PAGES; page++) {
    const qs = new URLSearchParams({ prefix: `${workspace}/`, per_page: String(R2_LIST_PER_PAGE) });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${API_BASE}/${env.CF_ACCOUNT_ID}/r2/buckets/${env.KB_BUCKET_NAME}/objects?${qs}`, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as
      | (ApiEnvelope<Array<{ key: string; size: number; last_modified?: string }>> & {
          result_info?: { cursor?: string; is_truncated?: boolean } | null;
        })
      | null;
    if (!res.ok || !data?.success) throw apiError(res, data);
    for (const o of data.result ?? []) out.push({ key: o.key, size: o.size, uploaded: o.last_modified ?? "" });
    const info = data.result_info;
    if (!info?.is_truncated || !info.cursor) break;
    cursor = info.cursor;
  }
  return out;
}

/** Starts an indexing job; returns the job id (null when the API does not return one). */
export async function kbTriggerSync(env: AgentEnv): Promise<string | null> {
  const res = await fetch(`${API_BASE}/${env.CF_ACCOUNT_ID}/ai-search/instances/${env.KB_AI_SEARCH}/jobs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as ApiEnvelope<{ id?: string }> | null;
  if (!res.ok || !data?.success) throw apiError(res, data);
  return data.result?.id ?? null;
}

export async function kbSyncStatus(env: AgentEnv): Promise<{ status: string; lastActivity: string | null }> {
  const res = await fetch(`${API_BASE}/${env.CF_ACCOUNT_ID}/ai-search/instances/${env.KB_AI_SEARCH}`, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as ApiEnvelope<{ status?: string; last_activity?: string | null }> | null;
  if (!res.ok || !data?.success) throw apiError(res, data);
  return { status: data.result?.status ?? "unknown", lastActivity: data.result?.last_activity ?? null };
}

export interface KbFileStatus {
  key: string;
  status: string;
  error?: string;
}

/** AI Search items API maximum page size (per_page 51 → 7001 "Too big: expected number to be <=50"). */
const ITEMS_PER_PAGE = 50;
const ITEMS_MAX_PAGES = 5;

/**
 * Per-file indexing status of one workspace, from the AI Search items API (paginated, 50/page, at most 5 pages;
 * the instance holds every workspace, so the workspace filter is applied here).
 *
 * The status is returned exactly as AI Search reports it, with no inference: AI Search per-file status is known to
 * be unreliable, an item can stay `running` long after it is searchable. Callers should treat it as a hint.
 */
export async function kbFileStatuses(env: AgentEnv, workspace: string): Promise<KbFileStatus[]> {
  assertWorkspace(workspace);
  const prefix = `${workspace}/`;
  const files: KbFileStatus[] = [];
  for (let page = 1; page <= ITEMS_MAX_PAGES; page++) {
    const res = await fetch(
      `${API_BASE}/${env.CF_ACCOUNT_ID}/ai-search/instances/${env.KB_AI_SEARCH}/items?per_page=${ITEMS_PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );
    const data = (await res.json().catch(() => null)) as ApiEnvelope<
      Array<{ key?: string; status?: string; error?: string | null }>
    > | null;
    if (!res.ok || !data?.success) throw apiError(res, data);
    const items = data.result ?? [];
    for (const it of items) {
      if (!it.key?.startsWith(prefix)) continue;
      files.push({ key: it.key, status: it.status ?? "unknown", ...(it.error ? { error: it.error } : {}) });
    }
    if (items.length < ITEMS_PER_PAGE) break;
  }
  return files;
}
