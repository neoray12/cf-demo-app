// Creating approvals and talking to the approval Workflow worker
// (workers/approval-workflow). App ↔ worker is HTTPS with a shared secret
// (x-approval-secret), so both sides also run locally.
import { addEvent, insertApproval, summarizeCall, transition, type Classification } from './approvals';
import type { ApprovalRef, RequestApproval } from './mcp-subagent';

export interface ApprovalEnv {
  HISTORY_DB?: D1Database;
  APPROVAL_WORKER_URL?: string;
  APPROVAL_SECRET?: string;
}

export function approvalsConfigured(env: ApprovalEnv): boolean {
  return Boolean(env.HISTORY_DB && env.APPROVAL_SECRET);
}

/**
 * POST to the worker; throws with its error text on failure. `/start` is retried once
 * on a timeout or 5xx: Workflow `create()` has hung for 15 s+ in production (2026-10-27),
 * and the worker treats an instance that already exists as started. `/event` is never
 * retried, so a decision is not sent twice.
 */
export async function callApprovalWorker(env: ApprovalEnv, path: '/start' | '/event', body: unknown): Promise<any> {
  if (!env.APPROVAL_WORKER_URL || !env.APPROVAL_SECRET) throw new Error('APPROVAL_WORKER_URL / APPROVAL_SECRET 未設定');
  const attempts = path === '/start' ? 2 : 1;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${env.APPROVAL_WORKER_URL.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-approval-secret': env.APPROVAL_SECRET },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt < attempts) continue;
      throw err;
    }
    const text = await res.text();
    if (res.status >= 500 && attempt < attempts) continue;
    if (!res.ok) throw new Error(`approval worker ${path} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
}

/** The worker's /start: one instance per approval (id = approval id); an existing one counts as started. */
export async function startWorkflowInstance(
  wf: { create(o: { id: string; params: { approvalId: string } }): Promise<{ id: string }>; get(id: string): Promise<{ id: string }> },
  approvalId: string,
): Promise<string> {
  try {
    return (await wf.create({ id: approvalId, params: { approvalId } })).id;
  } catch (err) {
    if (!/already.?exists/i.test((err as Error).message)) throw err;
    return (await wf.get(approvalId)).id;
  }
}

/** The subagent's hook: store the held-back write; high risk also starts the Workflow. */
export function approvalRequester(
  env: ApprovalEnv,
  who: { email: string; sessionId: string; conversationId: string | null; serverId: string; codeMode: boolean },
): RequestApproval {
  return async ({ toolName, args, classification }: { toolName: string; args: Record<string, unknown>; classification: Classification }): Promise<ApprovalRef> => {
    const db = env.HISTORY_DB!;
    const a = await insertApproval(db, {
      ...who,
      toolName,
      args,
      classification,
      summary: summarizeCall(toolName, args, classification),
    });
    if (a.risk === 'high') {
      try {
        const { instanceId } = await callApprovalWorker(env, '/start', { approvalId: a.id });
        await addEvent(db, a.id, { step: 'workflow', label: 'Workflow 已啟動' }, { workflowId: instanceId });
      } catch (err) {
        await transition(db, a.id, 'failed', { step: 'failed', label: 'Workflow 啟動失敗' }, { error: (err as Error).message });
        return { id: a.id, risk: a.risk, summary: a.summary, status: 'failed' };
      }
    }
    return { id: a.id, risk: a.risk, summary: a.summary, status: 'pending' };
  };
}
