import type { NextRequest } from "next/server";
import { kbFileStatuses, kbSyncStatus } from "@/lib/agents/kb";
import { kbJson, loadKbEnv, requireWorkspace, routeError } from "@/lib/agents/kb-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/kb/status[?workspace=]
 * -> { status, lastActivity } (instance level), plus `files: [{ key, status, error? }]` when a workspace is given.
 *
 * The per-file status is AI Search's own, passed through as-is: it is known to be unreliable (an item can stay
 * `running` long after it is searchable), so the UI should treat it as a hint and not infer anything from it.
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
    const [instance, files] = await Promise.all([
      kbSyncStatus(env),
      workspace ? kbFileStatuses(env, workspace) : Promise.resolve(undefined),
    ]);
    return kbJson(files ? { ...instance, files } : instance);
  } catch (err) {
    return routeError(err);
  }
}
