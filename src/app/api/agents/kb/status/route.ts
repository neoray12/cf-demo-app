import type { NextRequest } from "next/server";
import { kbFileStatuses, kbListDocs, kbRetrySyncIfPending, kbSyncStatus } from "@/lib/agents/kb";
import { kbJson, loadKbEnv, requireWorkspace, routeError } from "@/lib/agents/kb-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/kb/status[?workspace=]
 * -> { status, lastActivity } (instance level), plus `files: [{ key, status, error? }]`, `syncPending` and
 * `syncTriggered` when a workspace is given.
 *
 * The per-file status is AI Search's own, passed through as-is: it is known to be unreliable (an item can stay
 * `running` long after it is searchable), so the UI should treat it as a hint and not infer anything from it.
 *
 * Sync retry: AI Search refuses a sync right after another one (7020 `sync_in_cooldown`) and the instance's own
 * schedule is hours apart, so an upload made during a cooldown would sit unindexed. For a user workspace with a
 * document that is not `completed` (or not in the items list yet), this route triggers a sync again when the last
 * attempt (KV `kb-sync-attempt:{workspace}`) is older than 60 s. The UI polls this route with backoff, so the
 * retry repeats until AI Search accepts a job. The read-only `default` workspace never triggers a sync.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("workspace");
  let workspace: string | null = null;
  if (raw !== null) {
    const checked = requireWorkspace(raw);
    if (checked instanceof Response) return checked;
    workspace = checked;
  }
  try {
    const env = await loadKbEnv();
    const writable = workspace !== null && workspace !== "default";
    const [instance, files, docs] = await Promise.all([
      kbSyncStatus(env),
      workspace ? kbFileStatuses(env, workspace) : Promise.resolve(undefined),
      writable ? kbListDocs(env, workspace!).catch(() => null) : Promise.resolve(null),
    ]);
    if (!files) return kbJson(instance);
    const sync =
      writable && docs
        ? await kbRetrySyncIfPending(env, workspace!, docs.map((d) => d.key), files)
        : { syncPending: false, syncTriggered: false };
    return kbJson({ ...instance, files, ...sync });
  } catch (err) {
    return routeError(err);
  }
}
