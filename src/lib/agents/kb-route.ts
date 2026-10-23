// Shared plumbing for the /api/agents/kb/* routes: JSON helper, env loading and workspace validation.
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AgentEnv } from "./env";
import { isValidWorkspace } from "./kb";

export function kbJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function loadKbEnv(): Promise<AgentEnv> {
  const { env } = await getCloudflareContext();
  const e = env as unknown as Record<string, unknown>;
  return {
    ...e,
    CF_ACCOUNT_ID: (e.CF_ACCOUNT_ID as string) || "5efa272dc28e4e3933324c44165b6dbe",
  } as unknown as AgentEnv;
}

/** Returns the workspace id when valid, otherwise a 400 Response carrying an i18n error key. */
export function requireWorkspace(value: unknown): string | Response {
  if (typeof value !== "string" || !isValidWorkspace(value)) {
    return kbJson({ error: "agents.kb.errors.badWorkspace" }, 400);
  }
  return value;
}

export function routeError(err: unknown, status = 502): Response {
  return kbJson({ error: err instanceof Error ? err.message : String(err) }, status);
}
