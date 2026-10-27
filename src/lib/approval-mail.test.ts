import { describe, it, expect } from 'vitest';
import { approvalEmail, buildMime, parseRecipients } from './approval-mail';

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

  it('tells the manager they can also reply 核准 or 拒絕', () => {
    const m = approvalEmail(approval, 'https://x/a');
    for (const body of [m.text, m.html]) {
      expect(body).toContain('直接回覆這封信');
      expect(body).toContain('核准');
      expect(body).toContain('拒絕');
    }
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

  const base = { from: 'a@neokung.work', to: 'b@example.com', subject: 's', text: 't', html: 'h', messageId: '<m1@neokung.work>', date: new Date(0) };

  it('adds Reply-To when given, before the body', () => {
    const raw = buildMime({ ...base, replyTo: 'approvals+apr_1.0123456789abcdef@mail.neokung.work' });
    const head = raw.split('\r\n\r\n')[0]!;
    expect(head).toContain('\r\nReply-To: approvals+apr_1.0123456789abcdef@mail.neokung.work');
  });

  it('has no Reply-To when not given', () => {
    expect(buildMime(base)).not.toContain('Reply-To:');
  });

  it('adds extra headers in the header block', () => {
    const raw = buildMime({ ...base, headers: { 'In-Reply-To': '<r1@x>', References: '<r1@x>' } });
    const head = raw.split('\r\n\r\n')[0]!;
    expect(head).toContain('\r\nIn-Reply-To: <r1@x>');
    expect(head).toContain('\r\nReferences: <r1@x>');
  });
});

describe('parseRecipients', () => {
  it('splits a comma list, trims, drops blanks and duplicates', () => {
    expect(parseRecipients(' neo@cloudflare.com, neoray12@hotmail.com ,,neo@cloudflare.com')).toEqual(['neo@cloudflare.com', 'neoray12@hotmail.com']);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients(undefined)).toEqual([]);
  });
});
