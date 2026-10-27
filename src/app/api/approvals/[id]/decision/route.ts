import { approvalContext, noStore, publicView } from '@/lib/approval-route';
import { decisionRight, getApproval, recordDecision, transition } from '@/lib/approvals';
import { executeApproval } from '@/lib/approval-exec';
import { callApprovalWorker } from '@/lib/approval-service';

type Params = { params: Promise<{ id: string }> };

// POST { decision: "approve" | "reject", t? } — low risk: the requester in the chat,
// runs the write right away; high risk: the signed email link, resumes the Workflow.
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { decision?: unknown; t?: unknown };
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    return Response.json({ error: 'decision must be approve or reject' }, { status: 400 });
  }
  const ctx = await approvalContext(request, id, typeof body.t === 'string' ? body.t : null);
  if (ctx instanceof Response) return ctx;
  const { env, approval, viewer } = ctx;
  if (!decisionRight(approval, viewer)) {
    return Response.json({ error: approval.status === 'pending' ? 'forbidden' : `already ${approval.status}` }, { status: 409 });
  }
  const approve = body.decision === 'approve';
  const by = approval.risk === 'high' ? '主管（Email 連結）' : viewer.email ?? approval.email;

  if (approval.risk === 'high') {
    if (!approval.workflowId) return Response.json({ error: 'workflow not started' }, { status: 409 });
    // Record the decision first, so the Workflow's execute step finds it approved.
    const moved = await recordDecision(env.HISTORY_DB, id, approve, by);
    if (!moved) return Response.json({ error: 'already decided' }, { status: 409 });
    try {
      // The Workflow is waiting in step.waitForEvent; it runs the write itself.
      await callApprovalWorker(env, '/event', { instanceId: approval.workflowId, decision: body.decision, by });
    } catch (err) {
      if (approve) await transition(env.HISTORY_DB, id, 'failed', { step: 'failed', label: '無法通知 Workflow' }, { error: (err as Error).message });
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  } else {
    const moved = await recordDecision(env.HISTORY_DB, id, approve, by);
    if (!moved) return Response.json({ error: 'already decided' }, { status: 409 });
    if (approve) await executeApproval(env, id);
  }
  const latest = await getApproval(env.HISTORY_DB, id);
  return Response.json(publicView(latest!, viewer), { headers: noStore });
}
