import { deleteConversation, exportConversation, loadConversation, renameConversation } from '@/lib/chat-history';
import { historyContext, noStore } from '@/lib/history-route';

type Params = { params: Promise<{ id: string }> };

// GET — turns for the chat page; ?raw=1 — every full turn record (export).
export async function GET(request: Request, { params }: Params) {
  const ctx = await historyContext(request);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (new URL(request.url).searchParams.get('raw') === '1') {
    const data = await exportConversation(ctx.env, ctx.user.email, id);
    if (!data) return Response.json({ error: 'not found' }, { status: 404 });
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        ...noStore,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="chat-${id}.json"`,
      },
    });
  }
  const data = await loadConversation(ctx.env, ctx.user.email, id);
  if (!data) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json(data, { headers: noStore });
}

export async function PATCH(request: Request, { params }: Params) {
  const ctx = await historyContext(request);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const { title } = (await request.json().catch(() => ({}))) as { title?: unknown };
  if (typeof title !== 'string' || !title.trim()) return Response.json({ error: 'title is required' }, { status: 400 });
  const ok = await renameConversation(ctx.env.HISTORY_DB, ctx.user.email, id, title);
  return ok ? Response.json({ ok: true }) : Response.json({ error: 'not found' }, { status: 404 });
}

export async function DELETE(request: Request, { params }: Params) {
  const ctx = await historyContext(request);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const ok = await deleteConversation(ctx.env, ctx.user.email, id);
  return ok ? Response.json({ ok: true }) : Response.json({ error: 'not found' }, { status: 404 });
}
