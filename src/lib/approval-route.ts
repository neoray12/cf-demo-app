// Shared by the /api/approvals routes: load an approval and work out who is asking.
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getRequestUser } from './auth';
import { getApproval, decisionRight, type Approval, type ApprovalView } from './approvals';
import { verifyApprovalLink } from './approval-token';

export const noStore = { 'Cache-Control': 'no-store' };

export interface Viewer {
  requester: boolean;
  linkHolder: boolean;
  email: string | null;
}

export async function approvalContext(request: Request, id: string, token: string | null) {
  const { env } = await getCloudflareContext();
  const e = env as any;
  if (!e.HISTORY_DB || !e.APPROVAL_SECRET) return Response.json({ error: 'approvals not configured' }, { status: 503 });
  const approval = await getApproval(e.HISTORY_DB, id);
  if (!approval) return Response.json({ error: 'not found' }, { status: 404 });
  const user = await getRequestUser(request, e).catch(() => null);
  const viewer: Viewer = {
    requester: Boolean(user && user.email === approval.email),
    linkHolder: await verifyApprovalLink(e.APPROVAL_SECRET, id, token),
    email: user?.email ?? null,
  };
  if (!viewer.requester && !viewer.linkHolder) return Response.json({ error: 'forbidden' }, { status: 403 });
  return { env: e, approval, viewer };
}

const DASH = 'https://dash.cloudflare.com/5efa272dc28e4e3933324c44165b6dbe/workers/workflows/approval-workflow/instance';

/** What the card and the approval page see (no session id). */
export function publicView(a: Approval, viewer: Viewer): ApprovalView {
  return {
    id: a.id,
    requester: a.email,
    serverId: a.serverId,
    toolName: a.toolName,
    args: a.args,
    codeMode: a.codeMode,
    risk: a.risk,
    summary: a.summary,
    writes: a.writes,
    status: a.status,
    createdAt: a.createdAt,
    decidedAt: a.decidedAt,
    decidedBy: a.decidedBy,
    executedAt: a.executedAt,
    result: a.result,
    error: a.error,
    events: a.events,
    workflowId: a.workflowId,
    workflowUrl: a.workflowId ? `${DASH}/${a.workflowId}` : null,
    canDecide: decisionRight(a, viewer),
  };
}
