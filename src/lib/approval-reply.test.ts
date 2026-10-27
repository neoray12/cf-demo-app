import { describe, it, expect } from 'vitest';
import { replyAddress, parseReplyAddress, isApprover, replyDecision, stripQuoted, htmlToText } from './approval-reply';

const SECRET = 'test-secret';
const ID = 'apr_0123456789abcdef0123';

describe('replyAddress / parseReplyAddress', () => {
  it('round-trips an approval id through the signed sub-address', async () => {
    const addr = await replyAddress(SECRET, ID);
    expect(addr).toMatch(/^approvals\+apr_0123456789abcdef0123\.[0-9a-f]{16}@mail\.neokung\.work$/);
    expect(await parseReplyAddress(SECRET, addr)).toBe(ID);
  });

  it('uses the given domain', async () => {
    expect(await replyAddress(SECRET, ID, 'neokung.work')).toMatch(/@neokung\.work$/);
  });

  it('accepts a display name and different case', async () => {
    const addr = await replyAddress(SECRET, ID);
    expect(await parseReplyAddress(SECRET, `"Approvals" <${addr.toUpperCase()}>`)).toBe(ID);
  });

  it('rejects a signature with one character changed', async () => {
    const addr = await replyAddress(SECRET, ID);
    const at = addr.indexOf('@');
    const last = addr[at - 1]!;
    const forged = addr.slice(0, at - 1) + (last === '0' ? '1' : '0') + addr.slice(at);
    expect(await parseReplyAddress(SECRET, forged)).toBeNull();
  });

  it('rejects another approval id carrying an old signature', async () => {
    const addr = await replyAddress(SECRET, ID);
    const sig = addr.split('.')[1]!.split('@')[0]!;
    expect(await parseReplyAddress(SECRET, `approvals+apr_ffffffffffffffffffff.${sig}@mail.neokung.work`)).toBeNull();
  });

  it('rejects a different secret, the bare address and garbage', async () => {
    const addr = await replyAddress(SECRET, ID);
    expect(await parseReplyAddress('other-secret', addr)).toBeNull();
    expect(await parseReplyAddress(SECRET, 'approvals@mail.neokung.work')).toBeNull();
    expect(await parseReplyAddress(SECRET, 'not an address')).toBeNull();
    expect(await parseReplyAddress(SECRET, '')).toBeNull();
  });
});

describe('isApprover', () => {
  const list = 'neo@cloudflare.com, neoray12@hotmail.com';
  it('matches ignoring case and a display name', () => {
    expect(isApprover('Neo@Cloudflare.com', list)).toBe(true);
    expect(isApprover('Neo Kung <NEORAY12@hotmail.com>', list)).toBe(true);
  });
  it('rejects anyone else and an empty list', () => {
    expect(isApprover('attacker@example.com', list)).toBe(false);
    expect(isApprover('neo@cloudflare.com.evil.com', list)).toBe(false);
    expect(isApprover('neo@cloudflare.com', '')).toBe(false);
  });
});

describe('replyDecision', () => {
  it.each(['核准', '核准，謝謝', '同意', '准', 'OK!', 'ok', 'Approve', 'approved.', 'Yes', '「核准」'])('%s → approve', (t) => {
    expect(replyDecision(t)).toBe('approve');
  });
  it.each(['拒絕', '不同意', '不核准', '不准', '駁回，金額太大', 'reject', 'Rejected', 'No.'])('%s → reject', (t) => {
    expect(replyDecision(t)).toBe('reject');
  });
  it.each(['我再想想', '', '   ', 'not sure', 'hmm maybe later?? no idea', 'nope'])('%j → null', (t) => {
    expect(replyDecision(t)).toBeNull();
  });
  it('looks at the first non-empty line only', () => {
    expect(replyDecision('\n\n  核准\n不同意的話再說')).toBe('approve');
    expect(replyDecision('我再想想\n核准')).toBeNull();
  });
});

describe('stripQuoted', () => {
  it('cuts a Gmail English quote header', () => {
    expect(stripQuoted('核准\n\nOn Mon, Oct 27, 2026 at 3:00 PM Approvals <approvals@mail.neokung.work> wrote:\n> 核准或拒絕')).toBe('核准');
  });
  it('cuts a Gmail header wrapped over two lines', () => {
    expect(stripQuoted('核准\n\nOn Mon, Oct 27, 2026 at 3:00 PM Approvals <\napprovals@mail.neokung.work> wrote:\n> x').trim()).toBe('核准');
  });
  it('cuts a Gmail Chinese quote header', () => {
    expect(stripQuoted('拒絕\n\n在 2026年10月27日 週一 下午3:00，Approvals <approvals@mail.neokung.work> 寫道：\n> 核准').trim()).toBe('拒絕');
    expect(stripQuoted('拒絕\n\n於 2026年10月27日 週一 下午3:00 寫道：\n> 核准').trim()).toBe('拒絕');
  });
  it('cuts Outlook headers', () => {
    expect(stripQuoted('核准\r\n\r\n寄件者: Approvals <approvals@mail.neokung.work>\r\n寄件日期: 2026年10月27日\r\n核准或拒絕').trim()).toBe('核准');
    expect(stripQuoted('核准\n\nFrom: Approvals <approvals@mail.neokung.work>\nSent: Monday\n拒絕').trim()).toBe('核准');
    expect(stripQuoted('ok\n________________________________\n寄件者：x\n拒絕').trim()).toBe('ok');
  });
  it('cuts -----Original Message----- and drops > lines', () => {
    expect(stripQuoted('approve\n-----Original Message-----\nreject').trim()).toBe('approve');
    expect(stripQuoted('> 拒絕\n核准').trim()).toBe('核准');
  });
});

describe('htmlToText', () => {
  it('keeps line breaks, drops tags, decodes entities', () => {
    expect(htmlToText('<div dir="ltr">核准&nbsp;&amp; 謝謝</div><br><div class="gmail_quote"><blockquote>拒絕</blockquote></div>').split('\n')[0]!.trim()).toBe('核准 & 謝謝');
  });
  it('drops quoted blockquotes, styles and scripts', () => {
    const t = htmlToText('<style>p{}</style><p>OK</p><blockquote type="cite"><p>reject</p></blockquote>');
    expect(t).toContain('OK');
    expect(t).not.toContain('reject');
    expect(t).not.toContain('p{}');
  });
});
