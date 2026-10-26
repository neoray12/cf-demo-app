import { getCloudflareContext } from '@opennextjs/cloudflare';
import { executeApproval } from '@/lib/approval-exec';

type Params = { params: Promise<{ id: string }> };

// POST — internal: the approval Workflow's execute step (x-approval-secret).
export async function POST(request: Request, { params }: Params) {
  const { env } = await getCloudflareContext();
  const e = env as any;
  if (!e.APPROVAL_SECRET || request.headers.get('x-approval-secret') !== e.APPROVAL_SECRET) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id } = await params;
  const a = await executeApproval(e, id);
  if (!a) return Response.json({ error: 'not in the approved state' }, { status: 409 });
  return Response.json({ status: a.status, result: a.result, error: a.error });
}
