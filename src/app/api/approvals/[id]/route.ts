import { approvalContext, noStore, publicView } from '@/lib/approval-route';

type Params = { params: Promise<{ id: string }> };

// GET — the approval for its requester (logged in) or the holder of the signed email link (?t=).
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const ctx = await approvalContext(request, id, new URL(request.url).searchParams.get('t'));
  if (ctx instanceof Response) return ctx;
  return Response.json(publicView(ctx.approval, ctx.viewer), { headers: noStore });
}
