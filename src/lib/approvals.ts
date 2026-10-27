// Human-in-the-loop approvals for MCP writes (design:
// docs/superpowers/specs/2026-10-26-human-in-the-loop-approvals-design.md).
// A write the subagent wants to make becomes an approval row instead of a call:
// low risk is approved in the chat by the requester, high risk goes to a
// Cloudflare Workflow that emails the manager and waits for the decision.

export type Risk = 'low' | 'high';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed' | 'expired';

export interface ApprovalEvent {
  at: number;
  step: string;
  label: string;
}

export interface Classification {
  risk: Risk;
  /** Write tools involved (base names), e.g. ["sf_update_opportunity"]. */
  writes: string[];
}

export interface Approval {
  id: string;
  email: string;
  sessionId: string;
  conversationId: string | null;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  codeMode: boolean;
  risk: Risk;
  summary: string;
  writes: string[];
  status: ApprovalStatus;
  workflowId: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  executedAt: number | null;
  result: unknown;
  error: string | null;
  events: ApprovalEvent[];
}

/**
 * Home page "Human-in-the-loop" examples (strings: chat.hitlSuggestions.{key}).
 * `risk` is what classifyCall will decide for the write each prompt leads to.
 */
export const HITL_EXAMPLES: ReadonlyArray<{ key: string; risk: Risk }> = [
  { key: 'lead', risk: 'low' },
  { key: 'casePriority', risk: 'low' },
  { key: 'resetDeal', risk: 'low' },
  { key: 'closeDeal', risk: 'high' },
  { key: 'bigDeal', risk: 'high' },
  { key: 'sapRelease', risk: 'high' },
];

/** An approval as the chat card and the approval page see it (GET /api/approvals/{id}). */
export interface ApprovalView {
  id: string;
  requester: string;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  codeMode: boolean;
  risk: Risk;
  summary: string;
  writes: string[];
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  executedAt: number | null;
  result: unknown;
  error: string | null;
  events: ApprovalEvent[];
  workflowId: string | null;
  workflowUrl: string | null;
  canDecide: boolean;
}

/** Tool name without the delegate key (`tool_{server}_`) or portal server prefix. */
export function baseToolName(name: string, serverId?: string): string {
  let n = name;
  if (serverId && n.startsWith(`tool_${serverId}_`)) n = n.slice(`tool_${serverId}_`.length);
  return n.replace(/^(salesforce[-_]mcp|sap[-_]mcp)_/, '');
}

const HIGH_SAP = new Set([
  'sap_create_sales_order',
  'sap_release_production_order',
  'sap_teco_production_order',
  'sap_close_production_order',
]);
const BIG_AMOUNT = 1_000_000;

function writeRisk(base: string, args: Record<string, unknown> | null, scriptText?: string): Risk | null {
  if (HIGH_SAP.has(base)) return 'high';
  if (!/^sf_(create|update)_/.test(base)) return null;
  if (base === 'sf_update_opportunity' || base === 'sf_create_opportunity') {
    const stage = String(args?.stage ?? args?.StageName ?? '');
    const amount = Number(args?.amount ?? args?.Amount ?? 0);
    if (/closed/i.test(stage) || amount >= BIG_AMOUNT) return 'high';
    // In a script the arguments are code, not values: closing and big amounts
    // are spotted in its text.
    if (scriptText && /closed\s*(won|lost)/i.test(scriptText)) return 'high';
    const amounts = scriptText ? [...scriptText.matchAll(/amount["']?\s*:\s*["']?([\d_,]+)/gi)] : [];
    if (amounts.some((m) => Number(m[1]!.replace(/[_,]/g, '')) >= BIG_AMOUNT)) return 'high';
  }
  return 'low';
}

/** null = a read, call it as usual; otherwise the call needs an approval. */
export function classifyCall(name: string, args: Record<string, unknown>, serverId?: string): Classification | null {
  const base = baseToolName(name, serverId);
  if (base === 'portal_codemode_execute') {
    const code = String(args?.code ?? '');
    const found = [...code.matchAll(/codemode\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => baseToolName(m[1]!));
    const writes = [...new Set(found)].filter((w) => writeRisk(w, null, code) !== null);
    if (writes.length === 0) return null;
    const risk: Risk = writes.some((w) => writeRisk(w, null, code) === 'high') ? 'high' : 'low';
    return { risk, writes };
  }
  const risk = writeRisk(base, args);
  return risk ? { risk, writes: [base] } : null;
}

/** One line for the card, the email and the approval page. */
export function summarizeCall(name: string, args: Record<string, unknown>, c: Classification, serverId?: string): string {
  const base = baseToolName(name, serverId);
  if (base === 'portal_codemode_execute') return `Code Mode 腳本，包含寫入：${c.writes.join('、')}`;
  const shown = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== '')
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('，');
  return shown ? `${base}（${shown}）` : base;
}

const NEXT: Record<ApprovalStatus, ApprovalStatus[]> = {
  // failed: the Workflow could not be started.
  pending: ['approved', 'rejected', 'expired', 'failed'],
  // failed: the Workflow could not be resumed.
  approved: ['executing', 'failed'],
  executing: ['done', 'failed'],
  rejected: [],
  done: [],
  failed: [],
  expired: [],
};

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return NEXT[from].includes(to);
}

export function isTerminal(s: ApprovalStatus): boolean {
  return NEXT[s].length === 0;
}

/** What the approval page says when POST /decision fails (the route answers in short English codes). */
export function decisionErrorMessage(status: number, error: string | undefined): string {
  if (status === 403) return '連結無效或已過期，無法核准或拒絕。請從最新的審批信重新開啟。';
  if (status === 409 && error === 'forbidden') return '你沒有權限決定這筆審批：高風險審批要用審批信的連結或回信核准。';
  if (status === 409 && error?.startsWith('already')) return '這筆審批已經有人處理過了。';
  return error ?? `HTTP ${status}`;
}

/**
 * Who may approve or reject: low risk — the requester, in the chat; high risk —
 * whoever holds the signed email link (the manager), never the requester alone.
 */
export function decisionRight(
  a: { status: ApprovalStatus; risk: Risk },
  viewer: { requester: boolean; linkHolder: boolean },
): boolean {
  if (a.status !== 'pending') return false;
  return a.risk === 'low' ? viewer.requester : viewer.linkHolder;
}

export function appendEvent(eventsJson: string | null, e: ApprovalEvent): string {
  const list = eventsJson ? (JSON.parse(eventsJson) as ApprovalEvent[]) : [];
  return JSON.stringify([...list, e]);
}

export function newApprovalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `apr_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ── D1 (table `approvals`, migrations/chat-history/0003_approvals.sql) ──

interface Row {
  id: string;
  email: string;
  session_id: string;
  conversation_id: string | null;
  server_id: string;
  tool_name: string;
  args_json: string;
  code_mode: number;
  risk: Risk;
  summary: string;
  writes_json: string;
  status: ApprovalStatus;
  workflow_id: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  executed_at: number | null;
  result_json: string | null;
  error: string | null;
  events_json: string | null;
}

function fromRow(r: Row): Approval {
  return {
    id: r.id,
    email: r.email,
    sessionId: r.session_id,
    conversationId: r.conversation_id,
    serverId: r.server_id,
    toolName: r.tool_name,
    args: JSON.parse(r.args_json),
    codeMode: r.code_mode === 1,
    risk: r.risk,
    summary: r.summary,
    writes: JSON.parse(r.writes_json),
    status: r.status,
    workflowId: r.workflow_id,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    executedAt: r.executed_at,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    error: r.error,
    events: r.events_json ? JSON.parse(r.events_json) : [],
  };
}

export interface NewApproval {
  email: string;
  sessionId: string;
  conversationId: string | null;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  codeMode: boolean;
  classification: Classification;
  summary: string;
}

export async function insertApproval(db: D1Database, a: NewApproval): Promise<Approval> {
  const id = newApprovalId();
  const now = Date.now();
  const events = appendEvent(null, {
    at: now,
    step: 'created',
    label: a.classification.risk === 'high' ? '已建立審批（高風險，交給主管）' : '已建立審批（等待你核准）',
  });
  await db
    .prepare(
      `INSERT INTO approvals (id, email, session_id, conversation_id, server_id, tool_name, args_json, code_mode, risk, summary, writes_json, status, created_at, events_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(id, a.email, a.sessionId, a.conversationId, a.serverId, a.toolName, JSON.stringify(a.args), a.codeMode ? 1 : 0,
      a.classification.risk, a.summary, JSON.stringify(a.classification.writes), now, events)
    .run();
  return (await getApproval(db, id))!;
}

export async function getApproval(db: D1Database, id: string): Promise<Approval | null> {
  const r = await db.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

/**
 * Moves an approval to `to` only if its current status allows it (checked in the
 * UPDATE itself, so two deciders can't both win). Returns whether it moved.
 */
export async function transition(
  db: D1Database,
  id: string,
  to: ApprovalStatus,
  event: Omit<ApprovalEvent, 'at'>,
  patch: { decidedBy?: string; workflowId?: string; result?: unknown; error?: string } = {},
): Promise<boolean> {
  const from = (Object.keys(NEXT) as ApprovalStatus[]).filter((s) => canTransition(s, to));
  if (from.length === 0) return false;
  const current = await db.prepare('SELECT events_json FROM approvals WHERE id = ?').bind(id).first<{ events_json: string | null }>();
  if (!current) return false;
  const now = Date.now();
  const res = await db
    .prepare(
      `UPDATE approvals SET status = ?, events_json = ?,
         decided_at = CASE WHEN ? IN ('approved','rejected') THEN ? ELSE decided_at END,
         decided_by = COALESCE(?, decided_by),
         workflow_id = COALESCE(?, workflow_id),
         executed_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE executed_at END,
         result_json = COALESCE(?, result_json),
         error = COALESCE(?, error)
       WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
    )
    .bind(
      to, appendEvent(current.events_json, { at: now, ...event }),
      to, now,
      patch.decidedBy ?? null,
      patch.workflowId ?? null,
      to, now,
      patch.result === undefined ? null : JSON.stringify(patch.result).slice(0, 50_000),
      patch.error ?? null,
      id, ...from,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export function decisionLabel(approve: boolean, by: string): string {
  return approve ? `${by} 已核准` : `${by} 已拒絕`;
}

/**
 * Records an approve / reject decision (pending → approved | rejected). Shared by
 * the chat card, the signed email link and the email reply, so whichever
 * arrives first wins and the others get false.
 */
export async function recordDecision(db: D1Database, id: string, approve: boolean, by: string): Promise<boolean> {
  return transition(db, id, approve ? 'approved' : 'rejected', {
    step: approve ? 'approved' : 'rejected',
    label: decisionLabel(approve, by),
  }, { decidedBy: by });
}

/** Adds a timeline entry without changing the status (e.g. "email sent"). */
export async function addEvent(db: D1Database, id: string, event: Omit<ApprovalEvent, 'at'>, patch: { workflowId?: string } = {}): Promise<void> {
  const current = await db.prepare('SELECT events_json FROM approvals WHERE id = ?').bind(id).first<{ events_json: string | null }>();
  if (!current) return;
  await db
    .prepare('UPDATE approvals SET events_json = ?, workflow_id = COALESCE(?, workflow_id) WHERE id = ?')
    .bind(appendEvent(current.events_json, { at: Date.now(), ...event }), patch.workflowId ?? null, id)
    .run();
}
