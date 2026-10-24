import type { NextRequest } from "next/server";
import {
  countUploadedDocs,
  kbContentType,
  kbListDocs,
  kbSyncNow,
  kbUploadKey,
  MAX_UPLOAD_BYTES,
  safeUploadName,
  validateUpload,
} from "@/lib/agents/kb";
import { kbError, kbJson, loadKbEnv, requireWritableWorkspace, routeError } from "@/lib/agents/kb-route";
import { s3Put } from "@/lib/r2-s3";

export const dynamic = "force-dynamic";

// multipart framing / field overhead allowed on top of the file limit before the body is even parsed
const MULTIPART_OVERHEAD = 64 * 1024;

/**
 * POST /api/agents/kb/upload (multipart: file, workspace) -> { key, indexJobId, syncPending } | 400 { error: <i18n key> }
 *
 * Legacy path, kept working but no longer used by the UI: in production the zone WAF challenges binary multipart
 * bodies (403 HTML) before they reach the Worker. The UI uses /upload/presign -> PUT to R2 -> /upload/complete.
 */
export async function POST(request: NextRequest) {
  // Cheap early reject on the declared length; the real size is checked again on the parsed file below.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) {
    return kbError("tooLarge", 400);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Next's middleware layer buffers at most 10MB of a request body, so an over-limit upload surfaces here as a
    // truncated (unparseable) multipart body rather than as a File we could measure.
    return kbError(declared > MAX_UPLOAD_BYTES ? "tooLarge" : "noFile", 400);
  }
  const workspace = requireWritableWorkspace(form.get("workspace"));
  if (workspace instanceof Response) return workspace;
  const file = form.get("file");
  if (!(file instanceof File)) return kbError("noFile", 400);

  const safeName = safeUploadName(file.name);
  if (!safeName) return kbError("badName", 400);

  try {
    const env = await loadKbEnv();
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      console.error("[kb/upload] R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not configured");
      return kbError("server", 500);
    }

    const docs = await kbListDocs(env, workspace);
    // The cap counts top-level uploads only: imported pages under site/ have their own per-job cap.
    const uploaded = countUploadedDocs(workspace, docs);
    // Validate on the actual size, never on anything the client sent: the parsed File first, then the bytes read.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const invalid =
      validateUpload({ name: safeName, size: file.size }, uploaded) ??
      validateUpload({ name: safeName, size: bytes.byteLength }, uploaded);
    if (invalid) return kbJson({ error: invalid }, 400);

    const key = kbUploadKey(workspace, safeName, new Set(docs.map((d) => d.key)));

    const put = await s3Put({
      accountId: env.CF_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.KB_BUCKET_NAME,
      key,
      body: bytes,
      contentType: kbContentType(safeName),
    });
    if (!put.ok) {
      const detail = (await put.text().catch(() => "")).slice(0, 200);
      return routeError(new Error(`R2 upload failed (${put.status}): ${detail}`));
    }

    // Never throws: a refused (cooldown) or failed trigger is retried by the status route.
    const sync = await kbSyncNow(env, workspace);
    return kbJson({ key, indexJobId: sync.jobId, syncPending: sync.pending });
  } catch (err) {
    return routeError(err);
  }
}
