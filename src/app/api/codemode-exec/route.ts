import { NextRequest } from 'next/server';
import { isValidCodeModeToken } from '@/lib/codemode';

/**
 * Tool-call sink for Code Mode scripts.
 *
 * Dynamic Worker sandboxes running Code Mode scripts have their
 * `globalOutbound` pointed at this Worker, so `codemode.<tool>(args)` inside
 * the script arrives here. Requests carry a per-session token; anything
 * without a valid token (e.g. a stray fetch in generated code) is rejected.
 *
 * The actual tool implementations are handed over by the chat route via
 * `setCodeModeToolRunner` for the duration of one chat request.
 */

type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<unknown>;

// Set per-request by the chat route; lives only within this isolate.
let activeRunner: ToolRunner | null = null;

export function setCodeModeToolRunner(runner: ToolRunner | null) {
  activeRunner = runner;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { token?: string; name?: string; args?: Record<string, unknown> }
    | null;

  if (!body?.token || !body?.name) {
    return Response.json({ error: 'Missing token or tool name' }, { status: 400 });
  }
  if (!isValidCodeModeToken(body.token, body.name)) {
    return Response.json({ error: 'Invalid or expired Code Mode token' }, { status: 403 });
  }
  if (!activeRunner) {
    return Response.json({ error: 'No active Code Mode session in this isolate' }, { status: 409 });
  }

  try {
    const result = await activeRunner(body.name, body.args ?? {});
    return Response.json({ result });
  } catch (err) {
    return Response.json({ error: (err as Error).message || String(err) }, { status: 200 });
  }
}
