import { listConversations } from '@/lib/chat-history';
import { historyContext, noStore } from '@/lib/history-route';

// GET /api/chat/history?q=&limit=&before= — the caller's conversations, newest first.
export async function GET(request: Request) {
  const ctx = await historyContext(request);
  if (ctx instanceof Response) return ctx;
  const url = new URL(request.url);
  const conversations = await listConversations(ctx.env.HISTORY_DB, ctx.user.email, {
    q: url.searchParams.get('q') ?? undefined,
    limit: Number(url.searchParams.get('limit')) || undefined,
    before: Number(url.searchParams.get('before')) || undefined,
  });
  return Response.json({ conversations }, { headers: noStore });
}
