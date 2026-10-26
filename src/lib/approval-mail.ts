// The approval email the Workflow sends to the manager, as raw MIME for the
// send_email binding (EmailMessage takes a raw RFC 5322 message). Pure, shared
// with workers/approval-workflow.

export interface MailApproval {
  id: string;
  requester: string;
  summary: string;
  writes: string[];
  codeMode: boolean;
  args: Record<string, unknown>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function approvalEmail(a: MailApproval, link: string): { subject: string; text: string; html: string } {
  const detail = a.codeMode ? String(a.args.code ?? '') : JSON.stringify(a.args, null, 2);
  const subject = `[審批] ${a.requester} 要求執行：${a.writes.join('、')}`;
  const text = [
    `${a.requester} 透過 AI Agent 要求執行一個高風險寫入，需要你的核准。`,
    '',
    `動作：${a.summary}`,
    a.codeMode ? 'Code Mode 腳本：' : '參數：',
    detail,
    '',
    `核准或拒絕：${link}`,
    '',
    '連結 24 小時內有效；核准後由 Cloudflare Workflow 以送出者的身分寫入。',
  ].join('\n');
  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:560px">
<p><b>${esc(a.requester)}</b> 透過 AI Agent 要求執行一個高風險寫入，需要你的核准。</p>
<p>動作：${esc(a.summary)}</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:6px;white-space:pre-wrap;font-size:12px">${esc(detail)}</pre>
<p><a href="${esc(link)}" style="display:inline-block;background:#0a0a0a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">開啟審批頁</a></p>
<p style="color:#737373;font-size:12px">連結 24 小時內有效；核准後由 Cloudflare Workflow 以送出者的身分寫入。</p>
</div>`;
  return { subject, text, html };
}

function b64(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

export function buildMime(m: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  date?: Date;
}): string {
  const boundary = `b_${m.messageId.replace(/[^A-Za-z0-9]/g, '')}`;
  const subject = `=?UTF-8?B?${b64(m.subject).replace(/\r\n/g, '')}?=`;
  return [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${subject}`,
    `Message-ID: ${m.messageId}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(m.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(m.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
