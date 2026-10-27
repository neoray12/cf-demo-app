// Approve or reject a high-risk approval by replying to the approval email.
// The approval mail's Reply-To is a signed sub-address,
//   approvals+{approvalId}.{sig}@mail.neokung.work
// with sig = first 16 hex of HMAC-SHA256(APPROVAL_SECRET, "reply.{approvalId}"),
// so a reply can only target the approval it was sent for. Email Routing hands
// the reply to workers/approval-workflow's email() handler, which uses the
// helpers below. Pure, no Next / Node dependencies.
import { parseRecipients } from './approval-mail';

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

// Rejections are checked first so "不核准" / "不同意" never read as approvals.
// CJK words may be followed by anything ("核准，謝謝"); Latin words must end at
// a word boundary ("no" but not "nope" / "not sure").
const REJECT = /^(?:不\s*(?:核准|同意|准|批准)|拒絕|駁回|(?:rejected|reject|no)(?![a-z]))/i;
const APPROVE = /^(?:核准|同意|准|批准|(?:approved|approve|yes|ok)(?![a-z]))/i;

/** The decision in the first non-empty line of the reply, or null if unclear. */
export function replyDecision(text: string): 'approve' | 'reject' | null {
  const first = (text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first) return null;
  // Leading quotes / brackets: 「核准」, "OK".
  const line = first.replace(/^[\s"'「『【(（\[*]+/, '');
  if (REJECT.test(line)) return 'reject';
  if (APPROVE.test(line)) return 'approve';
  return null;
}
