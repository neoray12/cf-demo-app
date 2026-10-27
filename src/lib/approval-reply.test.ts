import { describe, it, expect } from 'vitest';
import { replyAddress, parseReplyAddress, isApprover, replyDecision, stripQuoted, htmlToText, handleReply, replySubject, type ReplyDeps } from './approval-reply';
import type { ApprovalStatus, Risk } from './approvals';

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

describe('replySubject', () => {
  it('keeps an existing reply prefix (English or Outlook Chinese)', () => {
    expect(replySubject('Re: [審批] x')).toBe('Re: [審批] x');
    expect(replySubject('RE: [審批] x')).toBe('RE: [審批] x');
    expect(replySubject('回覆: [審批] x')).toBe('回覆: [審批] x');
    expect(replySubject('答覆：[審批] x')).toBe('答覆：[審批] x');
  });
  it('adds Re: otherwise, with a fallback for an empty subject', () => {
    expect(replySubject('[審批] x')).toBe('Re: [審批] x');
    expect(replySubject('')).toBe('Re: 審批');
  });
});

describe('handleReply', () => {
  const APPROVERS = 'neo@cloudflare.com, neoray12@hotmail.com';

  /** In-memory approval + recorded side effects; decide() has the same first-wins guard as D1. */
  function setup(opts: { status?: ApprovalStatus; risk?: Risk; text?: string; exists?: boolean; workflowId?: string | null; resumeFails?: boolean } = {}) {
    const state = {
      status: opts.status ?? ('pending' as ApprovalStatus),
      events: [] as { step: string; label: string }[],
      resumed: [] as { workflowId: string; decision: string; by: string }[],
      failed: [] as string[],
      decidedBy: null as string | null,
      textRead: 0,
    };
    const deps: ReplyDeps = {
      secret: SECRET,
      approvers: APPROVERS,
      async get(id) {
        if (opts.exists === false || id !== ID) return null;
        return { id, status: state.status, risk: opts.risk ?? 'high', summary: 'sf_update_opportunity（stage: Closed Won）', workflowId: opts.workflowId === undefined ? 'apr_wf' : opts.workflowId };
      },
      async addEvent(id, e) {
        if (opts.exists !== false && id === ID) state.events.push(e);
      },
      async decide(_id, approve, by) {
        if (state.status !== 'pending') return false;
        state.status = approve ? 'approved' : 'rejected';
        state.decidedBy = by;
        state.events.push({ step: state.status, label: by });
        return true;
      },
      async fail(_id, error) {
        state.status = 'failed';
        state.failed.push(error);
      },
      async resume(workflowId, payload) {
        if (opts.resumeFails) throw new Error('instance not found');
        state.resumed.push({ workflowId, ...payload });
      },
      async readText() {
        state.textRead++;
        return opts.text ?? '核准\n\nOn Mon, Oct 27, 2026 Approvals <approvals@mail.neokung.work> wrote:\n> 拒絕';
      },
    };
    return { state, deps };
  }

  it('approves: records the decision, resumes the Workflow, confirms to the sender', async () => {
    const { state, deps } = setup();
    const r = await handleReply({ from: 'Neo@Cloudflare.com', to: await replyAddress(SECRET, ID) }, deps);
    expect(r.outcome).toBe('approved');
    expect(r.approvalId).toBe(ID);
    expect(state.status).toBe('approved');
    expect(state.decidedBy).toBe('主管（Email 回信：neo@cloudflare.com）');
    expect(state.resumed).toEqual([{ workflowId: 'apr_wf', decision: 'approve', by: '主管（Email 回信：neo@cloudflare.com）' }]);
    expect(r.reply).toContain('核准');
  });

  it('rejects', async () => {
    const { state, deps } = setup({ text: '不核准，金額不對' });
    const r = await handleReply({ from: 'neoray12@hotmail.com', to: await replyAddress(SECRET, ID) }, deps);
    expect(r.outcome).toBe('rejected');
    expect(state.status).toBe('rejected');
    expect(state.resumed[0]!.decision).toBe('reject');
    expect(r.reply).toContain('拒絕');
  });

  it('ignores a bad signature or an unknown approval silently', async () => {
    const a = setup();
    const addr = await replyAddress(SECRET, ID);
    const bad = await handleReply({ from: 'neo@cloudflare.com', to: addr.replace(/\.[0-9a-f]{16}@/, '.0000000000000000@') }, a.deps);
    expect(bad).toMatchObject({ outcome: 'bad-address', approvalId: null, reply: null });
    expect(a.state.events).toEqual([]);
    const b = setup({ exists: false });
    expect(await handleReply({ from: 'neo@cloudflare.com', to: addr }, b.deps)).toMatchObject({ outcome: 'not-found', reply: null });
    expect(b.state.textRead).toBe(0);
  });

  it('ignores a sender who is not an approver, notes it on the timeline, does not reply', async () => {
    const { state, deps } = setup();
    const r = await handleReply({ from: 'attacker@example.com', to: await replyAddress(SECRET, ID) }, deps);
    expect(r).toMatchObject({ outcome: 'not-approver', reply: null });
    expect(state.status).toBe('pending');
    expect(state.events).toEqual([{ step: 'reply_ignored', label: '收到非主管的回信（attacker@example.com），已忽略' }]);
    expect(state.textRead).toBe(0);
  });

  it('ignores a low-risk approval silently', async () => {
    const { state, deps } = setup({ risk: 'low' });
    const r = await handleReply({ from: 'neo@cloudflare.com', to: await replyAddress(SECRET, ID) }, deps);
    expect(r).toMatchObject({ outcome: 'not-high', reply: null });
    expect(state.status).toBe('pending');
  });

  it('tells the sender when it is no longer pending', async () => {
    const { state, deps } = setup({ status: 'expired' });
    const r = await handleReply({ from: 'neo@cloudflare.com', to: await replyAddress(SECRET, ID) }, deps);
    expect(r.outcome).toBe('not-pending');
    expect(r.reply).toContain('逾時');
    expect(state.resumed).toEqual([]);
  });

  it('asks again when the reply is unclear, status unchanged', async () => {
    const { state, deps } = setup({ text: '我再想想' });
    const r = await handleReply({ from: 'neo@cloudflare.com', to: await replyAddress(SECRET, ID) }, deps);
    expect(r.outcome).toBe('unclear');
    expect(r.reply).toContain('「核准」或「拒絕」');
    expect(state.status).toBe('pending');
    expect(state.events.at(-1)!.step).toBe('reply_unclear');
  });

  it('a second reply (or a resend) is told it was already handled', async () => {
    const { state, deps } = setup();
    const to = await replyAddress(SECRET, ID);
    await handleReply({ from: 'neo@cloudflare.com', to }, deps);
    const again = await handleReply({ from: 'neoray12@hotmail.com', to }, deps);
    expect(again.outcome).toBe('not-pending');
    expect(again.reply).toContain('已核准');
    expect(state.resumed).toHaveLength(1);
  });

  it('loses the race to the link cleanly: decide() false → already decided, no resume', async () => {
    const { state, deps } = setup();
    // The link decided between our read and our write.
    const decide = deps.decide;
    deps.decide = async (id, approve, by) => {
      state.status = 'rejected';
      return decide(id, approve, by);
    };
    const r = await handleReply({ from: 'neo@cloudflare.com', to: await replyAddress(SECRET, ID) }, deps);
    expect(r.outcome).toBe('already-decided');
    expect(r.reply).toContain('已經處理過');
    expect(state.resumed).toEqual([]);
  });

  it('marks an approval failed when the Workflow cannot be resumed', async () => {
    const { state, deps } = setup({ resumeFails: true });
    const r = await handleReply({ from: 'neo@cloudflare.com', to: await replyAddress(SECRET, ID) }, deps);
    expect(r.outcome).toBe('resume-failed');
    expect(state.status).toBe('failed');
    expect(state.failed).toEqual(['instance not found']);
    expect(r.reply).toBeTruthy();
  });
});
