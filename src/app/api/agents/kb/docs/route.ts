import type { NextRequest } from "next/server";
import { kbListDocs } from "@/lib/agents/kb";
import { kbJson, loadKbEnv, requireWorkspace, routeError } from "@/lib/agents/kb-route";

export const dynamic = "force-dynamic";

/** GET /api/agents/kb/docs?workspace= -> { docs: [{ key, size, uploaded }] } */
export async function GET(request: NextRequest) {
  const workspace = requireWorkspace(request.nextUrl.searchParams.get("workspace"));
  if (workspace instanceof Response) return workspace;
  try {
    const env = await loadKbEnv();
    return kbJson({ docs: await kbListDocs(env, workspace) });
  } catch (err) {
    return routeError(err);
  }
}
