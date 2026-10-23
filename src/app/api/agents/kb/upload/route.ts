import type { NextRequest } from "next/server";
import { kbListDocs, kbTriggerSync, MAX_UPLOAD_BYTES, safeUploadName, validateUpload } from "@/lib/agents/kb";
import { kbJson, loadKbEnv, requireWorkspace, routeError } from "@/lib/agents/kb-route";
import { s3Put } from "@/lib/r2-s3";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown",
  ".txt": "text/plain",
};
// multipart framing / field overhead allowed on top of the file limit before the body is even parsed
const MULTIPART_OVERHEAD = 64 * 1024;

/** POST /api/agents/kb/upload (multipart: file, workspace) -> { key, indexJobId } | 400 { error: <i18n key> } */
export async function POST(request: NextRequest) {
  // Cheap early reject on the declared length; the real size is checked again on the parsed file below.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) {
    return kbJson({ error: "agents.kb.errors.tooLarge" }, 400);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Next's middleware layer buffers at most 10MB of a request body, so an over-limit upload surfaces here as a
    // truncated (unparseable) multipart body rather than as a File we could measure.
    return kbJson({ error: declared > MAX_UPLOAD_BYTES ? "agents.kb.errors.tooLarge" : "agents.kb.errors.noFile" }, 400);
  }
  const workspace = requireWorkspace(form.get("workspace"));
  if (workspace instanceof Response) return workspace;
  const file = form.get("file");
  if (!(file instanceof File)) return kbJson({ error: "agents.kb.errors.noFile" }, 400);

  const safeName = safeUploadName(file.name);
  if (!safeName) return kbJson({ error: "agents.kb.errors.badName" }, 400);

  try {
    const env = await loadKbEnv();
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      return kbJson({ error: "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not configured" }, 500);
    }

    const docs = await kbListDocs(env, workspace);
    // Validate on the actual size, never on anything the client sent: the parsed File first, then the bytes read.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const invalid =
      validateUpload({ name: safeName, size: file.size }, docs.length) ??
      validateUpload({ name: safeName, size: bytes.byteLength }, docs.length);
    if (invalid) return kbJson({ error: invalid }, 400);

    const taken = new Set(docs.map((d) => d.key));
    let key = `${workspace}/${safeName}`;
    if (taken.has(key)) {
      const dot = safeName.lastIndexOf(".");
      const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
      const ext = dot > 0 ? safeName.slice(dot) : "";
      const suffix = crypto.randomUUID().slice(0, 4);
      key = `${workspace}/${stem}-${suffix}${ext}`;
    }

    const ext = safeName.slice(safeName.lastIndexOf(".")).toLowerCase();
    const put = await s3Put({
      accountId: env.CF_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.KB_BUCKET_NAME,
      key,
      body: bytes,
      contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
    });
    if (!put.ok) {
      const detail = (await put.text().catch(() => "")).slice(0, 200);
      return kbJson({ error: `R2 upload failed (${put.status}): ${detail}` }, 502);
    }

    let indexJobId: string | null = null;
    try {
      indexJobId = await kbTriggerSync(env);
    } catch {
      // The file is stored; the next scheduled sync (or a manual one) will still pick it up.
    }
    return kbJson({ key, indexJobId });
  } catch (err) {
    return routeError(err);
  }
}
