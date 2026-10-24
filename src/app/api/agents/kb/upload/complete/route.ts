import type { NextRequest } from "next/server";
import { isWorkspaceUploadKey, kbObjectSize, kbSyncNow } from "@/lib/agents/kb";
import { kbError, kbJson, loadKbEnv, requireWritableWorkspace, routeError } from "@/lib/agents/kb-route";

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/kb/upload/complete { workspace, key }
 * -> { key, size, indexJobId, syncPending } | 400/404 { error: <i18n key> }
 *
 * Called after the browser's presigned PUT to R2: checks the object exists (R2 REST list, CF_API_TOKEN) and triggers
 * an AI Search sync. `syncPending` is true when the sync was not accepted (7020 cooldown or an API error); the status
 * route then retries it while the UI polls.
 */
export async function POST(request: NextRequest) {
  let body: { workspace?: unknown; key?: unknown };
  try {
    body = await request.json();
  } catch {
    return kbError("badJson", 400);
  }
  const workspace = requireWritableWorkspace(body?.workspace);
  if (workspace instanceof Response) return workspace;
  if (!isWorkspaceUploadKey(workspace, body.key)) return kbError("badKey", 400);
  const key = body.key;

  try {
    const env = await loadKbEnv();
    const size = await kbObjectSize(env, key);
    if (size === null) return kbError("notUploaded", 404);
    const sync = await kbSyncNow(env, workspace);
    return kbJson({ key, size, indexJobId: sync.jobId, syncPending: sync.pending });
  } catch (err) {
    return routeError(err);
  }
}
