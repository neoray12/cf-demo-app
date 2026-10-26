// ApprovalWorkflow: one instance per high-risk approval (instance id = approval id).
//   load → email the manager a signed link → waitForEvent("decision", 24 h)
//   → approved: ask the app to run the write as the requester → email the result
// The app starts instances and delivers decisions through POST /start and
// POST /event (x-approval-secret); state lives in the app's D1 `approvals` table.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { EmailMessage } from 'cloudflare:email';
import { addEvent, getApproval, transition } from '../../../src/lib/approvals';
import { signApprovalLink } from '../../../src/lib/approval-token';
import { approvalEmail, buildMime, parseRecipients } from '../../../src/lib/approval-mail';

interface Env {
  APPROVAL_WORKFLOW: Workflow<Params>;
  HISTORY_DB: D1Database;
  APPROVAL_EMAIL?: SendEmail;
  APPROVAL_SECRET: string;
  APP_URL: string;
  MAIL_FROM: string;
  APPROVER_EMAIL: string;
  LOG_APPROVAL_LINK?: string;
}

type Params = { approvalId: string };
type Decision = { decision: 'approve' | 'reject'; by: string };

const DECISION_TIMEOUT_MS = 24 * 3600 * 1000;

/**
 * Sends to every approver in APPROVER_EMAIL. Returns who got it and who failed:
 * a failed send (e.g. an address not yet verified in Email Routing) is
 * recorded on the timeline instead of failing the Workflow.
 */
async function sendMail(env: Env, subject: string, text: string, html: string): Promise<{ sent: string[]; failed: string[] }> {
  const to = parseRecipients(env.APPROVER_EMAIL);
  if (!env.APPROVAL_EMAIL || to.length === 0) return { sent: [], failed: [] };
  const host = env.MAIL_FROM.split('@')[1] ?? 'localhost';
  const sent: string[] = [];
  const failed: string[] = [];
  for (const addr of to) {
    const raw = buildMime({ from: env.MAIL_FROM, to: addr, subject, text, html, messageId: `<${crypto.randomUUID()}@${host}>` });
    try {
      await env.APPROVAL_EMAIL.send(new EmailMessage(env.MAIL_FROM, addr, raw));
      sent.push(addr);
    } catch (err) {
      console.error(JSON.stringify({ event: 'approval.email_failed', to: addr, error: (err as Error).message }));
      failed.push(`${addr}（${(err as Error).message}）`);
    }
  }
  return { sent, failed };
}

export class ApprovalWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const db = this.env.HISTORY_DB;
    const id = event.payload.approvalId;

    const a = await step.do('load approval', async () => {
      const x = await getApproval(db, id);
      if (!x) throw new Error(`approval ${id} not found`);
      // Step results must be serializable: the arguments travel as JSON text.
      return { id: x.id, requester: x.email, summary: x.summary, writes: x.writes, codeMode: x.codeMode, argsJson: JSON.stringify(x.args) };
    });

    await step.do('email the manager', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } }, async () => {
      const token = await signApprovalLink(this.env.APPROVAL_SECRET, id, Date.now() + DECISION_TIMEOUT_MS);
      const link = `${this.env.APP_URL}/approvals/${id}?t=${encodeURIComponent(token)}`;
      const mail = approvalEmail({ ...a, args: JSON.parse(a.argsJson) as Record<string, unknown> }, link);
      const { sent, failed } = await sendMail(this.env, mail.subject, mail.text, mail.html);
      if (this.env.LOG_APPROVAL_LINK === '1') console.log(JSON.stringify({ event: 'approval.link', approvalId: id, link }));
      if (sent.length) await addEvent(db, id, { step: 'email', label: `已寄審批信給主管（${sent.join('、')}）` });
      if (failed.length) await addEvent(db, id, { step: 'email_failed', label: `寄信失敗：${failed.join('；')}` });
      if (!sent.length && !failed.length) await addEvent(db, id, { step: 'email', label: '審批連結已產生（未設定寄信，見 Worker log）' });
      return { sent, failed };
    });

    let decision: Decision;
    try {
      const ev = await step.waitForEvent<Decision>('wait for the manager', { type: 'decision', timeout: '24 hours' });
      decision = ev.payload;
    } catch {
      await step.do('expire', async () => {
        await transition(db, id, 'expired', { step: 'expired', label: '24 小時內沒有人核准，已逾時' });
      });
      return { status: 'expired' };
    }

    if (decision.decision !== 'approve') return { status: 'rejected', by: decision.by };

    const outcome = await step.do('run the write as the requester', { retries: { limit: 2, delay: '10 seconds', backoff: 'linear' } }, async () => {
      const res = await fetch(`${this.env.APP_URL}/api/approvals/${id}/execute`, {
        method: 'POST',
        headers: { 'x-approval-secret': this.env.APPROVAL_SECRET },
      });
      const body = (await res.json().catch(() => ({}))) as { status?: string; result?: unknown; error?: string | null };
      // 409: already executed or not approved — retrying would not change that.
      if (!res.ok && res.status !== 409) throw new Error(`execute ${res.status}: ${body.error ?? ''}`);
      return { status: body.status ?? `http ${res.status}`, error: body.error ?? null };
    });

    await step.do('email the result', async () => {
      const ok = outcome.status === 'done';
      const subject = `[審批結果] ${ok ? '已完成' : '失敗'}：${a.writes.join('、')}`;
      const text = `${a.summary}\n\n結果：${ok ? '已寫入' : `失敗 — ${outcome.error ?? outcome.status}`}`;
      await sendMail(this.env, subject, text, `<p>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/\n/g, '<br>')}</p>`);
    });

    return outcome;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('cf-approval-workflow: human-in-the-loop approvals for the CF demo app');
    }
    if (request.method !== 'POST' || request.headers.get('x-approval-secret') !== env.APPROVAL_SECRET || !env.APPROVAL_SECRET) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (url.pathname === '/start' && typeof body.approvalId === 'string') {
      const instance = await env.APPROVAL_WORKFLOW.create({ id: body.approvalId, params: { approvalId: body.approvalId } });
      console.log(JSON.stringify({ event: 'approval.start', approvalId: body.approvalId, instanceId: instance.id }));
      return Response.json({ instanceId: instance.id });
    }
    if (url.pathname === '/event' && typeof body.instanceId === 'string' && (body.decision === 'approve' || body.decision === 'reject')) {
      const instance = await env.APPROVAL_WORKFLOW.get(body.instanceId);
      await instance.sendEvent({ type: 'decision', payload: { decision: body.decision, by: String(body.by ?? '') } });
      console.log(JSON.stringify({ event: 'approval.decision', instanceId: body.instanceId, decision: body.decision }));
      return Response.json({ ok: true, status: await instance.status() });
    }
    return Response.json({ error: 'bad request' }, { status: 400 });
  },
};
