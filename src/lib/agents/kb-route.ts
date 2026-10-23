// Shared plumbing for the /api/agents/kb/* routes: JSON helper, env loading and workspace validation.
// Every error body is `{ error: "agents.kb.errors.<key>" }` (an i18n key, never English text); 5xx details are logged.
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AgentEnv } from "./env";
import { isValidWorkspace } from "./kb";

export function kbJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** 4xx/5xx body carrying an i18n key (`agents.kb.errors.<key>`). */
export function kbError(key: string, status: number): Response {
  return kbJson({ error: `agents.kb.errors.${key}` }, status);
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
  if (typeof value !== "string" || !isValidWorkspace(value)) return kbError("badWorkspace", 400);
  return value;
}

/** Like requireWorkspace, but also rejects `default`: the seed workspace is read-only through the API. */
export function requireWritableWorkspace(value: unknown): string | Response {
  const ws = requireWorkspace(value);
  if (ws instanceof Response) return ws;
  if (ws === "default") return kbError("readOnlyWorkspace", 400);
  return ws;
}

/** 5xx response: the detail is logged server-side, the client only gets the generic `server` key. */
export function routeError(err: unknown, status = 502): Response {
  console.error("[kb]", err instanceof Error ? err.message : String(err));
  return kbError("server", status);
}
