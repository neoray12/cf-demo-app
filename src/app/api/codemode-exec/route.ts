import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { verifyCodeModeSession, codeModeSecret } from '@/lib/codemode';
import { buildToolSet } from '@/lib/chat-tools';

/**
 * Tool-call sink for Code Mode scripts.
 *
 * Dynamic Worker sandboxes running Code Mode scripts have their
 * `globalOutbound` pointed at this Worker, so `codemode.<tool>(args)` inside
 * the script arrives here. The request carries a signed session token that
 * describes the tool set; the tools are rebuilt from it on every call, so it
 * does not matter which isolate the service binding routes this request to.
 * Anything without a valid token (e.g. a stray fetch in generated code) is
 * rejected.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { token?: string; name?: string; args?: Record<string, unknown> }
    | null;

  if (!body?.token || !body?.name) {
    return Response.json({ error: 'Missing token or tool name' }, { status: 400 });
  }

  const { env } = await getCloudflareContext();
  const session = await verifyCodeModeSession(codeModeSecret(env as any), body.token);
  if (!session || !session.toolNames.includes(body.name)) {
    return Response.json({ error: 'Invalid or expired Code Mode token' }, { status: 403 });
  }

  const { tools } = await buildToolSet(env as any, session);
  const tool = tools[body.name];
  if (!tool) {
    return Response.json({ error: `Unknown tool: ${body.name}` }, { status: 200 });
  }

  try {
    const result = await tool.execute(body.args ?? {});
    return Response.json({ result });
  } catch (err) {
    return Response.json({ error: (err as Error).message || String(err) }, { status: 200 });
  }
}
