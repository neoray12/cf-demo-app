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

/** POST to the worker; throws with its error text on failure. */
export async function callApprovalWorker(env: ApprovalEnv, path: '/start' | '/event', body: unknown): Promise<any> {
  if (!env.APPROVAL_WORKER_URL || !env.APPROVAL_SECRET) throw new Error('APPROVAL_WORKER_URL / APPROVAL_SECRET 未設定');
  const res = await fetch(`${env.APPROVAL_WORKER_URL.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-approval-secret': env.APPROVAL_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`approval worker ${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
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
