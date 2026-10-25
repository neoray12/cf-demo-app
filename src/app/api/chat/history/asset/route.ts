import { ownsAssetKey } from '@/lib/chat-history';
import { historyContext } from '@/lib/history-route';

// GET /api/chat/history/asset?key= — an image pasted into one of the caller's own turns.
export async function GET(request: Request) {
  const ctx = await historyContext(request);
  if (ctx instanceof Response) return ctx;
  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!(await ownsAssetKey(ctx.user.email, key))) return Response.json({ error: 'not found' }, { status: 404 });
  const obj = await ctx.env.HISTORY_BUCKET.get(key);
  if (!obj) return Response.json({ error: 'not found' }, { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
