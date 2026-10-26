import { describe, it, expect } from 'vitest';
import { approvalEmail, buildMime } from './approval-mail';

const approval = {
  id: 'apr_1',
  requester: 'neo@cloudflare.com',
  summary: 'sf_update_opportunity（opportunity_id: 006，stage: Closed Won）',
  writes: ['sf_update_opportunity'],
  codeMode: false,
  args: { opportunity_id: '006', stage: 'Closed Won' },
};

describe('approvalEmail', () => {
  it('names the requester and the action and links to the approval page', () => {
    const m = approvalEmail(approval, 'https://demo.neokung.work/approvals/apr_1?t=1.x');
    expect(m.subject).toContain('審批');
    expect(m.text).toContain('neo@cloudflare.com');
    expect(m.text).toContain('Closed Won');
    expect(m.text).toContain('https://demo.neokung.work/approvals/apr_1?t=1.x');
    expect(m.html).toContain('href="https://demo.neokung.work/approvals/apr_1?t=1.x"');
  });

  it('escapes HTML coming from the model', () => {
    const m = approvalEmail({ ...approval, summary: '<img src=x onerror=alert(1)>' }, 'https://x/a');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img');
  });
});

describe('buildMime', () => {
  it('builds a UTF-8 multipart/alternative message', () => {
    const raw = buildMime({ from: 'a@neokung.work', to: 'b@example.com', subject: '審批', text: '純文字', html: '<p>HTML</p>', messageId: '<m1@neokung.work>', date: new Date(0) });
    expect(raw).toContain('From: a@neokung.work\r\n');
    expect(raw).toContain('To: b@example.com\r\n');
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain('Message-ID: <m1@neokung.work>\r\n');
    expect(raw).toContain('Content-Type: multipart/alternative; boundary=');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    // Body parts decode back to the original UTF-8 text.
    const b64 = raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1]!.split('\r\n--')[0]!.replace(/\r\n/g, '');
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe('純文字');
  });
});
