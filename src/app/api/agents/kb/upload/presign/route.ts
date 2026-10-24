import type { NextRequest } from "next/server";
import {
  countUploadedDocs,
  kbContentType,
  kbListDocs,
  kbUploadKey,
  safeUploadName,
  validateUpload,
} from "@/lib/agents/kb";
import { kbError, kbJson, loadKbEnv, requireWritableWorkspace, routeError } from "@/lib/agents/kb-route";
import { presignPut } from "@/lib/r2-s3";

export const dynamic = "force-dynamic";

const PRESIGN_EXPIRES_S = 300;

/**
 * POST /api/agents/kb/upload/presign { workspace, name, size, type }
 * -> { key, url, headers: { "content-type" } } | 400 { error: <i18n key> }
 *
 * The browser PUTs the file straight to R2 with the returned URL (bucket CORS allows the app origins), which keeps
 * binary bodies away from the zone WAF (it challenged multipart PDFs with a 403 HTML page) and from Next's 10 MB
 * request-body buffering. The URL signs content-type + content-length, so the PUT must carry exactly the validated
 * size and the server-chosen type. `type` from the client is ignored; then /upload/complete triggers indexing.
 */
export async function POST(request: NextRequest) {
  let body: { workspace?: unknown; name?: unknown; size?: unknown; type?: unknown };
  try {
    body = await request.json();
  } catch {
    return kbError("badJson", 400);
  }
  const workspace = requireWritableWorkspace(body?.workspace);
  if (workspace instanceof Response) return workspace;
  if (typeof body.name !== "string") return kbError("noFile", 400);
  const size = body.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return kbError("noFile", 400);
  const safeName = safeUploadName(body.name);
  if (!safeName) return kbError("badName", 400);

  try {
    const env = await loadKbEnv();
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      console.error("[kb/upload/presign] R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not configured");
      return kbError("server", 500);
    }
    const docs = await kbListDocs(env, workspace);
    const invalid = validateUpload({ name: safeName, size }, countUploadedDocs(workspace, docs));
    if (invalid) return kbJson({ error: invalid }, 400);

    const key = kbUploadKey(workspace, safeName, new Set(docs.map((d) => d.key)));
    const contentType = kbContentType(safeName);
    const url = await presignPut({
      accountId: env.CF_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.KB_BUCKET_NAME,
      key,
      contentType,
      contentLength: size,
      expiresSeconds: PRESIGN_EXPIRES_S,
    });
    return kbJson({ key, url, headers: { "content-type": contentType } });
  } catch (err) {
    return routeError(err);
  }
}
