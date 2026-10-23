// Knowledge-base core: workspace ids, upload validation, and the AI Search / R2 REST calls.
// A workspace is a folder prefix (`default/`, `ws-xxxxxxxx/`) in the KB_BUCKET_NAME R2 bucket that is indexed
// by the KB_AI_SEARCH instance; searches are scoped to it with a folder filter.
import type { AgentEnv } from "./env";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const WORKSPACE_RE = /^(default|ws-[a-z0-9]{8})$/;
const MIN_SCORE = 0.3;
// Each seed doc is one chunk of up to ~1.5k chars; a shorter snippet cut off facts that sit late in the document.
const SNIPPET_MAX = 1500;
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

export async function kbListDocs(
  env: AgentEnv,
  workspace: string,
): Promise<Array<{ key: string; size: number; uploaded: string }>> {
  assertWorkspace(workspace);
  const res = await fetch(
    `${API_BASE}/${env.CF_ACCOUNT_ID}/r2/buckets/${env.KB_BUCKET_NAME}/objects?prefix=${encodeURIComponent(`${workspace}/`)}`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(API_TIMEOUT_MS) },
  );
  const data = (await res.json().catch(() => null)) as ApiEnvelope<
    Array<{ key: string; size: number; last_modified?: string }>
  > | null;
  if (!res.ok || !data?.success) throw apiError(res, data);
  return (data.result ?? []).map((o) => ({ key: o.key, size: o.size, uploaded: o.last_modified ?? "" }));
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
