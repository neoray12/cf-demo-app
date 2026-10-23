import type { NextRequest } from "next/server";
import { kbTriggerSync, slugFromUrl } from "@/lib/agents/kb";
import { kbJson, loadKbEnv, requireWorkspace, routeError } from "@/lib/agents/kb-route";
import { s3Put } from "@/lib/r2-s3";

export const dynamic = "force-dynamic";

const BR_BASE = "https://api.cloudflare.com/client/v4/accounts";
const BR_TIMEOUT_MS = 30_000;
const CRAWL_LIMIT = 30;
const CRAWL_DEPTH = 2;
const MAX_RECORD_PAGES = 10;
const WRITE_CONCURRENCY = 5;

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
    return kbJson({ error: "Invalid JSON body" }, 400);
  }
  const workspace = requireWorkspace(body?.workspace);
  if (workspace instanceof Response) return workspace;
  const url = parseHttpUrl(body?.url);
  if (!url) return kbJson({ error: "agents.kb.errors.badUrl" }, 400);

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
      return kbJson({ error: data?.errors?.[0]?.message ?? `Failed to start crawl (HTTP ${res.status})` }, 502);
    }
    return kbJson({ jobId: data.result });
  } catch (err) {
    return routeError(err);
  }
}

/**
 * GET ?jobId=&workspace= -> { status: "running", finished, total } while crawling; once the job has finished, every
 * completed page is written to `{workspace}/site/{slug}.md` (metadata `sourceurl`), a sync is triggered and
 * `{ status, saved, indexJobId }` is returned (status is the crawl job's final status, "completed" on success).
 */
export async function GET(request: NextRequest) {
  const workspace = requireWorkspace(request.nextUrl.searchParams.get("workspace"));
  if (workspace instanceof Response) return workspace;
  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) return kbJson({ error: "jobId is required" }, 400);

  try {
    const env = await loadKbEnv();
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      return kbJson({ error: "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not configured" }, 500);
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

    // Finished: collect every record (cursor-paginated).
    const pages: CrawlRecord[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_RECORD_PAGES; i++) {
      const job = await fetchJob(cursor ? `cursor=${encodeURIComponent(cursor)}` : "limit=50");
      pages.push(...(job.records ?? []));
      cursor = job.cursor;
      if (!cursor) break;
    }

    const used = new Set<string>();
    const toWrite: Array<{ key: string; markdown: string; sourceUrl: string }> = [];
    for (const rec of pages) {
      if (rec.status !== "completed" || !rec.markdown?.trim() || !rec.url) continue;
      let sourceUrl: string;
      try {
        sourceUrl = new URL(rec.url).href; // percent-encodes non-ASCII so it is a valid header value
      } catch {
        continue;
      }
      const base = slugFromUrl(sourceUrl);
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 76)}-${n}`;
      used.add(slug);
      toWrite.push({ key: `${workspace}/site/${slug}.md`, markdown: rec.markdown, sourceUrl });
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
    }

    let indexJobId: string | null = null;
    if (saved > 0) {
      try {
        indexJobId = await kbTriggerSync(env);
      } catch {
        // Files are stored; a later sync will index them.
      }
    }
    return kbJson({ status: head.status, saved, indexJobId });
  } catch (err) {
    return routeError(err);
  }
}
