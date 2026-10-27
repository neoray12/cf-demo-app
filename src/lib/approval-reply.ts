// Approve or reject a high-risk approval by replying to the approval email.
// The approval mail's Reply-To is a signed sub-address,
//   approvals+{approvalId}.{sig}@mail.neokung.work
// with sig = first 16 hex of HMAC-SHA256(APPROVAL_SECRET, "reply.{approvalId}"),
// so a reply can only target the approval it was sent for. Email Routing hands
// the reply to workers/approval-workflow's email() handler, which uses the
// helpers below. Pure, no Next / Node dependencies.
import { parseRecipients } from './approval-mail';
import type { ApprovalEvent, ApprovalStatus, Risk } from './approvals';

const enc = new TextEncoder();
const LOCAL = 'approvals';

async function replySig(secret: string, approvalId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`reply.${approvalId}`)));
  return [...mac.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** "Name <a@b>" → "a@b", lower-cased. */
function bareAddress(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1]! : s).trim().toLowerCase();
}

export async function replyAddress(secret: string, approvalId: string, domain = 'mail.neokung.work'): Promise<string> {
  return `${LOCAL}+${approvalId}.${await replySig(secret, approvalId)}@${domain}`;
}

/** The approval id a reply was addressed to, or null if the address is not one we signed. */
export async function parseReplyAddress(secret: string, to: string): Promise<string | null> {
  const m = /^approvals\+(apr_[0-9a-f]+)\.([0-9a-f]{16})@[^@\s]+$/.exec(bareAddress(to ?? ''));
  if (!m) return null;
  const [, id, sig] = m;
  const expected = await replySig(secret, id!);
  // Constant-time compare of two 16-char hex strings.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig!.charCodeAt(i);
  return diff === 0 ? id! : null;
}

export function isApprover(from: string, approverList: string | undefined): boolean {
  const addr = bareAddress(from ?? '');
  return parseRecipients(approverList).some((a) => a.toLowerCase() === addr);
}

// Where the quoted original starts: Gmail ("On … wrote:", "在/於 … 寫道："),
// Outlook ("From:", "寄件者:", the underscore rule) and "-----Original Message-----".
const QUOTE_START = [
  /^on\s.*wrote:\s*$/i,
  /^.*\bwrote:\s*$/i,
  /^[在於].*寫道[:：]\s*$/,
  /^(from|寄件者|寄件人)\s*[:：]/i,
  /^-{2,}\s*original message\s*-{2,}/i,
  /^_{10,}\s*$/,
];

/** The reply's own text: everything above the quoted original, without "> " lines. */
export function stripQuoted(text: string): string {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (QUOTE_START.some((re) => re.test(line))) {
      // Gmail wraps a long "On … <addr> wrote:" header over two lines.
      if (/wrote:\s*$|寫道[:：]\s*$/i.test(line) && i > 0 && /^(on|在|於)\s?/i.test(lines[i - 1]!.trim()) && !/^(on|在|於)\s?/i.test(line)) out.pop();
      break;
    }
    if (line.startsWith('>')) continue;
    out.push(lines[i]!);
  }
  return out.join('\n').trim();
}

/** Plain text from an HTML-only reply, without quoted blocks. */
export function htmlToText(html: string): string {
  return (html ?? '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// A decision runs an irreversible write, so anything ambiguous is null (the
// manager is asked again). Rejections are checked first so "不核准" / "不同意"
// never read as approvals. A CJK keyword must be followed by the end of the
// line, whitespace, punctuation or a polite tail ("核准，謝謝", "核准了") — not
// by more words ("核准前想先確認", "准備", "同意書"). Latin words end at a word
// boundary; a bare "no" only counts on its own or before punctuation
// ("No." / "No, …"), not "No problem" / "No access to email until Monday".
const TAIL = String.raw`(?=$|[\s,.!~。，、！～;；:：)）」』】]|謝謝|感謝|了|囉|喔|啦)`;
const REJECT = new RegExp(String.raw`^(?:(?:不\s*(?:核准|同意|准|批准)|拒絕|駁回)${TAIL}|(?:rejected|reject)(?![a-z])|no(?=$|[,.!，。！]))`, 'i');
const APPROVE = new RegExp(String.raw`^(?:(?:核准|同意|准|批准)${TAIL}|(?:approved|approve|yes|ok)(?![a-z]))`, 'i');
// A question or a hedge is never a decision: "核准嗎？", "OK?", "核准不了".
const QUESTION = /[?？]|嗎|呢|不了/;

/** The decision in the first non-empty line of the reply, or null if unclear. */
export function replyDecision(text: string): 'approve' | 'reject' | null {
  const first = (text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first || QUESTION.test(first)) return null;
  // Leading quotes / brackets: 「核准」, "OK".
  const line = first.replace(/^[\s"'「『【(（\[*]+/, '');
  if (REJECT.test(line)) return 'reject';
  if (APPROVE.test(line)) return 'approve';
  return null;
}

/** Subject of the confirmation: the manager's own subject, "Re: " added unless it already has a reply prefix. */
export function replySubject(subject: string): string {
  const s = (subject ?? '').trim() || '審批';
  return /^(re|回覆|答覆)\s*[:：]/i.test(s) ? s : `Re: ${s}`;
}

// ── The email() handler's logic, with its side effects injected ──

/**
 * Out-of-office and other machine replies (RFC 3834 Auto-Submitted, the common
 * X-Autoreply / X-Autorespond, Precedence: bulk | auto_reply | junk | list).
 * They come from an approver's address to the signed Reply-To, so without this
 * an auto-reply's first line could be read as a decision.
 */
export function isAutoReply(headers: { get(name: string): string | null } | undefined): boolean {
  if (!headers) return false;
  const auto = headers.get('auto-submitted');
  if (auto && !/^\s*no\b/i.test(auto)) return true;
  if (headers.get('x-autoreply') || headers.get('x-autorespond')) return true;
  return /^\s*(bulk|auto_reply|junk|list)\b/i.test(headers.get('precedence') ?? '');
}

export type ReplyOutcome =
  | 'bad-address'
  | 'auto-reply'
  | 'not-approver'
  | 'not-found'
  | 'not-high'
  | 'no-workflow'
  | 'not-pending'
  | 'unclear'
  | 'approved'
  | 'rejected'
  | 'already-decided'
  | 'resume-failed';

export interface ReplyDeps {
  secret: string;
  /** APPROVER_EMAIL: comma-separated. */
  approvers: string | undefined;
  get(id: string): Promise<{ id: string; status: ApprovalStatus; risk: Risk; summary: string; workflowId: string | null } | null>;
  addEvent(id: string, e: Omit<ApprovalEvent, 'at'>): Promise<void>;
  /** recordDecision: false if someone else decided first. */
  decide(id: string, approve: boolean, by: string): Promise<boolean>;
  /** Marks an approved request failed (the Workflow could not be resumed). */
  fail(id: string, error: string): Promise<void>;
  /** Delivers the decision to the waiting Workflow instance. */
  resume(workflowId: string, payload: { decision: 'approve' | 'reject'; by: string }): Promise<void>;
  /** The reply's text (MIME already decoded); only read once the sender and approval checked out. */
  readText(): Promise<string>;
}

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: '等待核准',
  approved: '已核准',
  rejected: '已拒絕',
  executing: '執行中',
  done: '已完成',
  failed: '失敗',
  expired: '已逾時',
};

/**
 * Handles one reply to an approval email. `reply` is the confirmation text to
 * send back to the sender, or null when nothing should be sent (forged
 * address, unknown approval, not an approver — never act as a mail relay).
 */
export async function handleReply(
  msg: { from: string; to: string; headers?: { get(name: string): string | null } },
  deps: ReplyDeps,
): Promise<{ outcome: ReplyOutcome; approvalId: string | null; reply: string | null }> {
  const id = await parseReplyAddress(deps.secret, msg.to);
  if (!id) return { outcome: 'bad-address', approvalId: null, reply: null };
  const done = (outcome: ReplyOutcome, reply: string | null = null) => ({ outcome, approvalId: id, reply });
  // Never answer a machine (mail loops) and never read it as a decision.
  if (isAutoReply(msg.headers)) return done('auto-reply');
  const sender = bareAddress(msg.from);

  if (!isApprover(sender, deps.approvers)) {
    await deps.addEvent(id, { step: 'reply_ignored', label: `收到非主管的回信（${sender.slice(0, 200)}），已忽略` });
    return done('not-approver');
  }
  const a = await deps.get(id);
  if (!a) return done('not-found');
  if (a.risk !== 'high') return done('not-high');
  if (a.status !== 'pending') {
    return done('not-pending', `這筆審批目前是「${STATUS_LABEL[a.status]}」，不需要再回覆。\n\n${a.summary}`);
  }
  if (!a.workflowId) return done('no-workflow');

  const decision = replyDecision(stripQuoted(await deps.readText()));
  if (!decision) {
    await deps.addEvent(id, { step: 'reply_unclear', label: `收到主管回信（${sender}），但無法判斷核准或拒絕` });
    return done('unclear', `沒有看懂你的回覆。請在回信的第一行寫「核准」或「拒絕」。\n\n${a.summary}`);
  }

  const approve = decision === 'approve';
  const by = `主管（Email 回信：${sender}）`;
  if (!(await deps.decide(id, approve, by))) {
    const now = await deps.get(id);
    return done('already-decided', `這筆審批已經處理過（目前：${STATUS_LABEL[now?.status ?? a.status]}），這封回信沒有改變任何事。`);
  }
  try {
    await deps.resume(a.workflowId, { decision, by });
  } catch (err) {
    const message = (err as Error).message;
    if (approve) await deps.fail(id, message);
    return done('resume-failed', `已記錄你的${approve ? '核准' : '拒絕'}，但無法通知 Workflow（${message}）${approve ? '，這筆寫入不會執行' : ''}。`);
  }
  return approve
    ? done('approved', `已收到你的核准：${a.summary}\n\nWorkflow 會以送出者的身分執行寫入，完成後另寄結果通知。`)
    : done('rejected', `已收到你的拒絕：${a.summary}\n\n這筆寫入不會執行。`);
}
