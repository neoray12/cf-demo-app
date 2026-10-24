import type { NextRequest } from "next/server";
import { hostSlugFromUrl, kbSyncNow, slugFromUrl } from "@/lib/agents/kb";
import { kbError, kbJson, loadKbEnv, requireWritableWorkspace, routeError } from "@/lib/agents/kb-route";
import { s3Put } from "@/lib/r2-s3";

export const dynamic = "force-dynamic";

const BR_BASE = "https://api.cloudflare.com/client/v4/accounts";
const BR_TIMEOUT_MS = 30_000;
const CRAWL_LIMIT = 30;
const CRAWL_DEPTH = 2;
const MAX_RECORD_PAGES = 10;
const WRITE_CONCURRENCY = 5;
const JOB_TTL_S = 3600;
// A "writing" marker older than this is treated as abandoned (the poll that set it crashed or timed out).
const WRITING_STALE_MS = 120_000;

interface CrawlRecord {
  url?: string;
  status?: string;
  markdown?: string;
}
interface CrawlJob {
  status?: string;
  finished?: number;
  total?: number;
  cursor?: string;
  records?: CrawlRecord[];
}
interface BrEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
}

/**
 * KV record binding a crawl job to its workspace. `status` is "running" (crawling), "writing" (a poll is saving
 * pages) or the crawl's final status ("completed" on success), in which case saved/failed/indexJobId are set.
 */
interface ImportRecord {
  workspace: string;
  url: string;
  status: string;
  writingAt?: number;
  saved?: number;
  failed?: number;
  indexJobId?: string | null;
}

const jobKey = (jobId: string) => `kb-import:${jobId}`;

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** POST { url, workspace } -> starts a Browser Rendering /crawl job -> { jobId } */
export async function POST(request: NextRequest) {
  let body: { url?: unknown; workspace?: unknown };
  try {
    body = await request.json();
  } catch {
    return kbError("badJson", 400);
  }
  const workspace = requireWritableWorkspace(body?.workspace);
  if (workspace instanceof Response) return workspace;
  const url = parseHttpUrl(body?.url);
  if (!url) return kbError("badUrl", 400);

  try {
    const env = await loadKbEnv();
    const res = await fetch(`${BR_BASE}/${env.CF_ACCOUNT_ID}/browser-rendering/crawl`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.href, limit: CRAWL_LIMIT, depth: CRAWL_DEPTH, formats: ["markdown"] }),
      signal: AbortSignal.timeout(BR_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as BrEnvelope<string> | null;
    if (!res.ok || !data?.success || !data.result) {
      return routeError(new Error(data?.errors?.[0]?.message ?? `Failed to start crawl (HTTP ${res.status})`));
    }
    const record: ImportRecord = { workspace, url: url.href, status: "running" };
    await env.KV.put(jobKey(data.result), JSON.stringify(record), { expirationTtl: JOB_TTL_S });
    return kbJson({ jobId: data.result });
  } catch (err) {
    return routeError(err);
  }
}

/**
 * GET ?jobId=&workspace= -> { status: "running", finished, total } while crawling. Once the job has finished, every
 * completed page is written to `{workspace}/site/{hostSlug}/{slug}.md` (metadata `sourceurl`), a sync is triggered and
 * `{ status, saved, failed, indexJobId }` is returned (`status` is the crawl's final status, "completed" on success).
 * `failed` counts pages that were not saved: records the crawler reported as errored plus failed R2 writes.
 *
 * The job must have been started by POST for the same workspace (KV record `kb-import:{jobId}`, 1h TTL): unknown
 * job -> 404, other workspace -> 403. After completion the stored result is returned as-is on every further poll,
 * without rewriting or re-syncing. A "writing" marker in the same record stops concurrent polls from writing twice;
 * KV is eventually consistent, so that is best-effort (a rare double write only rewrites the same keys).
 */
export async function GET(request: NextRequest) {
  const workspace = requireWritableWorkspace(request.nextUrl.searchParams.get("workspace"));
  if (workspace instanceof Response) return workspace;
  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) return kbError("missingJobId", 400);

  try {
    const env = await loadKbEnv();
    const record = await env.KV.get<ImportRecord>(jobKey(jobId), "json");
    if (!record) return kbError("unknownJob", 404);
    if (record.workspace !== workspace) return kbError("wrongWorkspace", 403);
    if (record.status !== "running" && record.status !== "writing") {
      return kbJson({
        status: record.status,
        saved: record.saved ?? 0,
        failed: record.failed ?? 0,
        indexJobId: record.indexJobId ?? null,
      });
    }

    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      return routeError(new Error("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not configured"), 500);
    }
    const jobUrl = `${BR_BASE}/${env.CF_ACCOUNT_ID}/browser-rendering/crawl/${jobId}`;
    const fetchJob = async (qs: string): Promise<CrawlJob> => {
      const res = await fetch(`${jobUrl}?${qs}`, {
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        signal: AbortSignal.timeout(BR_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as BrEnvelope<CrawlJob> | null;
      if (!res.ok || !data?.success || !data.result) {
        throw new Error(data?.errors?.[0]?.message ?? `Crawl status failed (HTTP ${res.status})`);
      }
      return data.result;
    };

    const head = await fetchJob("limit=1");
    if (!head.status || head.status === "running") {
      return kbJson({ status: "running", finished: head.finished ?? 0, total: head.total ?? 0 });
    }
    // Another poll is already saving the pages: report progress, do not write again.
    if (record.status === "writing" && Date.now() - (record.writingAt ?? 0) < WRITING_STALE_MS) {
      return kbJson({ status: "running", finished: head.finished ?? 0, total: head.total ?? 0 });
    }
    await env.KV.put(jobKey(jobId), JSON.stringify({ ...record, status: "writing", writingAt: Date.now() }), {
      expirationTtl: JOB_TTL_S,
    });

    try {
      // Collect every record (cursor-paginated).
      const pages: CrawlRecord[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < MAX_RECORD_PAGES; i++) {
        const job = await fetchJob(cursor ? `cursor=${encodeURIComponent(cursor)}` : "limit=50");
        pages.push(...(job.records ?? []));
        cursor = job.cursor;
        if (!cursor) break;
      }

      let failed = pages.filter((r) => r.status === "errored").length;
      const used = new Set<string>();
      const toWrite: Array<{ key: string; markdown: string; sourceUrl: string }> = [];
      for (const rec of pages) {
        if (rec.status !== "completed" || !rec.markdown?.trim() || !rec.url) continue;
        if (toWrite.length >= CRAWL_LIMIT) break;
        let sourceUrl: string;
        try {
          sourceUrl = new URL(rec.url).href; // percent-encodes non-ASCII so it is a valid header value
        } catch {
          continue;
        }
        const dir = `${workspace}/site/${hostSlugFromUrl(sourceUrl)}`;
        const base = slugFromUrl(sourceUrl);
        let slug = base;
        for (let n = 2; used.has(`${dir}/${slug}`); n++) slug = `${base.slice(0, 76)}-${n}`;
        used.add(`${dir}/${slug}`);
        toWrite.push({ key: `${dir}/${slug}.md`, markdown: rec.markdown, sourceUrl });
      }

      let saved = 0;
      for (let i = 0; i < toWrite.length; i += WRITE_CONCURRENCY) {
        const results = await Promise.all(
          toWrite.slice(i, i + WRITE_CONCURRENCY).map(async (p) => {
            const res = await s3Put({
              accountId: env.CF_ACCOUNT_ID,
              accessKeyId: env.R2_ACCESS_KEY_ID,
              secretAccessKey: env.R2_SECRET_ACCESS_KEY,
              bucket: env.KB_BUCKET_NAME,
              key: p.key,
              body: new TextEncoder().encode(p.markdown),
              contentType: "text/markdown",
              metadata: { sourceurl: p.sourceUrl },
            });
            if (!res.ok) console.error(`[kb/import-site] R2 PUT ${p.key} failed: ${res.status}`);
            return res.ok;
          }),
        );
        saved += results.filter(Boolean).length;
        failed += results.filter((ok) => !ok).length;
      }

      let indexJobId: string | null = null;
      if (saved > 0) {
        // Never throws; a cooldown (7020) / failed trigger is retried by the status route while the UI polls.
        indexJobId = (await kbSyncNow(env, workspace)).jobId;
      }
      const done: ImportRecord = { workspace, url: record.url, status: head.status, saved, failed, indexJobId };
      await env.KV.put(jobKey(jobId), JSON.stringify(done), { expirationTtl: JOB_TTL_S });
      return kbJson({ status: head.status, saved, failed, indexJobId });
    } catch (err) {
      // Release the marker so the next poll can retry.
      await env.KV.put(jobKey(jobId), JSON.stringify({ ...record, status: "running" }), { expirationTtl: JOB_TTL_S }).catch(
        () => undefined,
      );
      throw err;
    }
  } catch (err) {
    return routeError(err);
  }
}
