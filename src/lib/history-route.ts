// Shared guard for /api/chat/history/*: verified user + configured bindings.
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getRequestUser, type RequestUser } from './auth';
import { historyConfigured, type HistoryEnv } from './chat-history';

export type HistoryContext = { user: RequestUser; env: Required<HistoryEnv> };

export async function historyContext(request: Request): Promise<HistoryContext | Response> {
  const { env } = await getCloudflareContext();
  const user = await getRequestUser(request, env as any);
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  if (!historyConfigured(env as any)) return Response.json({ error: 'history storage not configured' }, { status: 503 });
  return { user, env: env as unknown as Required<HistoryEnv> };
}

export const noStore = { 'Cache-Control': 'no-store' };
