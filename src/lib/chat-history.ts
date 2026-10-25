// Main chat history: one full record per turn in R2 (HISTORY_BUCKET), an index
// in D1 (HISTORY_DB) for the list / search / stats. Spec:
// docs/superpowers/specs/2026-10-25-main-chat-tracing-history-design.md
import { applyChatEvent, createTurnState, type ChatStreamEvent, type MessagePart, type ToolCallInfo, type TurnState } from './chat-turn';
import type { TimelineEvent } from './chat-timeline';
import type { ToolPolicy } from './tool-policy';

export const HISTORY_RECORD_VERSION = 1;
const CONVERSATION_ID_RE = /^[\w-]{1,100}$/;
const INDEX_TEXT_MAX = 4000;
const TITLE_MAX = 60;
/** Safety cap on the raw event log; a runaway stream must not grow one record without bound. */
const MAX_LOGGED_EVENTS = 50_000;

export type TurnStatus = 'completed' | 'error' | 'client-aborted';

export interface TurnRequestInfo {
  model: string;
  provider: string;
  compatModelId: string;
  /** What the harness gave the model this turn (core tools, direct MCP servers, subagents). */
  toolPolicy: ToolPolicy;
  /** Code Mode comparison example, if this turn is one of its runs. */
  experiment: { id: string; codeMode: boolean } | null;
  mcpServers: string[];
  edgeColo: string | null;
  country: string | null;
  userAgent: string | null;
  maxOutputTokens: number | null;
  systemPrompt: string;
  tools: Array<{ name: string; description: string }>;
  /** The conversation as sent to the model (text history; images only on the newest turn). */
  messages: Array<{ role: string; content: string }>;
  /** What the user typed for this turn, as shown in their bubble. */
  userText: string;
  /** Filled by saveTurn: R2 keys of the pasted images. */
  imageKeys: string[];
  attachments: Array<{ name: string; bytes: number; sandboxPath: string | null }>;
}

export interface GatewayCall {
  /** Which model call this belongs to, e.g. "stream-1", "smart-retry". */
  attempt: string;
  path: string;
  status: number;
  startedMs: number;
  headersMs: number;
  cfRay: string | null;
  aigLogId: string | null;
  aigCacheStatus: string | null;
  routedModel: string | null;
}

export interface ModelAttempt {
  attempt: string;
  startedMs: number;
  endedMs: number;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  steps: Array<{ finishReason: string | null; usage: Record<string, unknown> | null; responseId: string | null; modelId: string | null; toolCalls: number }>;
  error: string | null;
}

export interface TurnRecord {
  v: number;
  conversationId: string;
  turnIndex: number;
  email: string;
  userName: string;
  authSource: 'access' | 'login';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  ttftMs: number | null;
  status: TurnStatus;
  request: TurnRequestInfo;
  response: {
    assistant: Omit<TurnState, 'events'>;
    timeline: { events: TimelineEvent[]; endAt: number };
  };
  attempts: ModelAttempt[];
  gatewayCalls: GatewayCall[];
  errors: ChatStreamEvent[];
  /** Every NDJSON event the browser received, with `t` = ms since the turn started. */
  events: Array<{ t: number } & ChatStreamEvent>;
}

export function isValidConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id);
}

/** First line of the first message, trimmed to a list-friendly length. */
export function deriveTitle(text: string): string {
  const line = text.replace(/📎[\s\S]*$/, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const t = line || text.trim() || '（圖片）';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** R2 folder per user — a hash, so object keys don't carry the email. */
export async function userPrefix(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `users/${hex.slice(0, 16)}`;
}

export function turnKey(prefix: string, conversationId: string, turnIndex: number): string {
  return `${prefix}/${conversationId}/turn-${String(turnIndex).padStart(4, '0')}.json`;
}

/** Collects everything about one /api/chat request while it streams. */
export class TurnRecorder {
  private readonly startMs: number;
  private state: TurnState = createTurnState();
  private readonly log: Array<{ t: number } & ChatStreamEvent> = [];
  private readonly errors: ChatStreamEvent[] = [];
  private readonly attempts: ModelAttempt[] = [];
  private readonly gatewayCalls: GatewayCall[] = [];
  private ttftMs: number | null = null;
  private droppedEvents = 0;
  clientGone = false;

  constructor(
    private readonly base: {
      conversationId: string;
      turnIndex: number;
      user: { email: string; name: string; source: 'access' | 'login' };
      request: TurnRequestInfo;
    },
    private readonly clock: () => number = Date.now,
  ) {
    this.startMs = clock();
  }

  /** ms since the turn started */
  elapsed(): number {
    return this.clock() - this.startMs;
  }

  onEvent(ev: ChatStreamEvent): void {
    const t = this.elapsed();
    if (this.log.length < MAX_LOGGED_EVENTS) this.log.push({ t, ...ev });
    else this.droppedEvents++;
    if (this.ttftMs === null && (ev.type === 'text-delta' || ev.type === 'reasoning-delta') && ev.text) this.ttftMs = t;
    if (ev.type === 'error') this.errors.push(ev);
    this.state = applyChatEvent(this.state, ev, t);
  }

  noteGatewayCall(call: Omit<GatewayCall, 'startedMs' | 'headersMs'> & { startedMs: number }): void {
    this.gatewayCalls.push({ ...call, headersMs: this.elapsed() });
  }

  noteAttempt(attempt: ModelAttempt): void {
    this.attempts.push(attempt);
  }

  finish(): TurnRecord {
    const durationMs = this.elapsed();
    const { events, ...assistant } = this.state;
    const status: TurnStatus = this.clientGone
      ? 'client-aborted'
      : this.errors.length > 0 && !assistant.content
        ? 'error'
        : 'completed';
    if (this.droppedEvents) this.errors.push({ type: 'recorder', message: `${this.droppedEvents} events not logged (cap ${MAX_LOGGED_EVENTS})` });
    return {
      v: HISTORY_RECORD_VERSION,
      conversationId: this.base.conversationId,
      turnIndex: this.base.turnIndex,
      email: this.base.user.email,
      userName: this.base.user.name,
      authSource: this.base.user.source,
      startedAt: new Date(this.startMs).toISOString(),
      endedAt: new Date(this.startMs + durationMs).toISOString(),
      durationMs,
      ttftMs: this.ttftMs,
      status,
      request: this.base.request,
      response: { assistant, timeline: { events, endAt: durationMs } },
      attempts: this.attempts,
      gatewayCalls: this.gatewayCalls,
      errors: this.errors,
      events: this.log,
    };
  }
}

// ── Persistence ──

export interface HistoryEnv {
  HISTORY_DB?: D1Database;
  HISTORY_BUCKET?: R2Bucket;
}

export function historyConfigured(env: HistoryEnv): env is Required<HistoryEnv> {
  return Boolean(env.HISTORY_DB && env.HISTORY_BUCKET);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Sum of a usage field across the turn's model calls. */
function usageTotal(record: TurnRecord, field: string): number | null {
  let total: number | null = null;
  for (const a of record.attempts) {
    const v = num(a.usage?.[field]);
    if (v !== null) total = (total ?? 0) + v;
  }
  return total;
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mediaType: string; ext: string } | null {
  const m = /^data:(image\/[\w.+-]+);base64,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = (m[1]!.split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace(/\+.*$/, '');
  return { bytes, mediaType: m[1]!, ext };
}

/**
 * Store one turn: images + full record in R2, then the D1 index. A conversation
 * id that already belongs to another email is never written to.
 */
export async function saveTurn(env: Required<HistoryEnv>, record: TurnRecord, images: string[]): Promise<void> {
  const db = env.HISTORY_DB;
  const owner = await db.prepare('SELECT email FROM conversations WHERE id = ?').bind(record.conversationId).first<{ email: string }>();
  if (owner && owner.email !== record.email) {
    console.warn(`[history] conversation ${record.conversationId} belongs to another user — not saved`);
    return;
  }

  const prefix = await userPrefix(record.email);
  const key = turnKey(prefix, record.conversationId, record.turnIndex);
  const imageKeys: string[] = [];
  for (const [i, url] of images.entries()) {
    const img = decodeDataUrl(url);
    if (!img) continue;
    const imageKey = key.replace(/\.json$/, `-image-${i}.${img.ext}`);
    await env.HISTORY_BUCKET.put(imageKey, img.bytes, { httpMetadata: { contentType: img.mediaType } });
    imageKeys.push(imageKey);
  }
  const stored: TurnRecord = { ...record, request: { ...record.request, imageKeys } };
  await env.HISTORY_BUCKET.put(key, JSON.stringify(stored), { httpMetadata: { contentType: 'application/json' } });

  const startedAt = Date.parse(record.startedAt);
  const endedAt = Date.parse(record.endedAt);
  const assistant = record.response.assistant;
  const lastAttempt = record.attempts[record.attempts.length - 1];
  const toolNames = [...new Set(assistant.toolCalls.map((tc) => tc.name))];

  await db.batch([
    db
      .prepare(
        `INSERT INTO turns (conversation_id, turn_index, email, started_at, ended_at, duration_ms, ttft_ms, status, model, provider,
           compat_model, routed_model, finish_reason, input_tokens, output_tokens, reasoning_tokens, tool_calls, tool_names, error_type,
           user_text, assistant_text, r2_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT (conversation_id, turn_index) DO UPDATE SET
           started_at = excluded.started_at, ended_at = excluded.ended_at, duration_ms = excluded.duration_ms, ttft_ms = excluded.ttft_ms,
           status = excluded.status, model = excluded.model, provider = excluded.provider, compat_model = excluded.compat_model,
           routed_model = excluded.routed_model, finish_reason = excluded.finish_reason, input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens, reasoning_tokens = excluded.reasoning_tokens, tool_calls = excluded.tool_calls,
           tool_names = excluded.tool_names, error_type = excluded.error_type, user_text = excluded.user_text,
           assistant_text = excluded.assistant_text, r2_key = excluded.r2_key
         WHERE turns.email = excluded.email`,
      )
      .bind(
        record.conversationId,
        record.turnIndex,
        record.email,
        startedAt,
        endedAt,
        record.durationMs,
        record.ttftMs,
        record.status,
        record.request.model,
        record.request.provider,
        record.request.compatModelId,
        assistant.routedModel?.model ?? null,
        lastAttempt?.finishReason ?? null,
        usageTotal(record, 'inputTokens'),
        usageTotal(record, 'outputTokens'),
        usageTotal(record, 'reasoningTokens'),
        assistant.toolCalls.length,
        toolNames.length ? JSON.stringify(toolNames) : null,
        (record.errors.find((e) => e.type === 'error')?.errorType as string | undefined) ?? null,
        record.request.userText.slice(0, INDEX_TEXT_MAX),
        assistant.content.slice(0, INDEX_TEXT_MAX),
        key,
      ),
    db
      .prepare(
        `INSERT INTO conversations (id, email, title, model, provider, created_at, updated_at, last_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET model = excluded.model, provider = excluded.provider,
           updated_at = excluded.updated_at, last_status = excluded.last_status
         WHERE conversations.email = excluded.email`,
      )
      .bind(record.conversationId, record.email, deriveTitle(record.request.userText), record.request.model, record.request.provider, startedAt, endedAt, record.status),
    db
      .prepare(
        `UPDATE conversations SET
           turn_count = (SELECT COUNT(*) FROM turns WHERE conversation_id = ?1),
           input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM turns WHERE conversation_id = ?1),
           output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM turns WHERE conversation_id = ?1)
         WHERE id = ?1 AND email = ?2`,
      )
      .bind(record.conversationId, record.email),
  ]);
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string | null;
  provider: string | null;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  lastStatus: string | null;
}

interface ConversationRow {
  id: string;
  title: string;
  model: string | null;
  provider: string | null;
  created_at: number;
  updated_at: number;
  turn_count: number;
  input_tokens: number;
  output_tokens: number;
  last_status: string | null;
}

function toSummary(r: ConversationRow): ConversationSummary {
  return {
    id: r.id,
    title: r.title,
    model: r.model,
    provider: r.provider,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    turnCount: r.turn_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    lastStatus: r.last_status,
  };
}

export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function listConversations(
  db: D1Database,
  email: string,
  opts: { q?: string; limit?: number; before?: number },
): Promise<ConversationSummary[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 100);
  const before = opts.before && Number.isFinite(opts.before) ? opts.before : Number.MAX_SAFE_INTEGER;
  const q = opts.q?.trim();
  const cols = 'id, title, model, provider, created_at, updated_at, turn_count, input_tokens, output_tokens, last_status';
  const stmt = q
    ? db
        .prepare(
          `SELECT ${cols} FROM conversations
           WHERE email = ?1 AND updated_at < ?2 AND (
             title LIKE ?3 ESCAPE '\\' OR id IN (
               SELECT conversation_id FROM turns WHERE email = ?1 AND (user_text LIKE ?3 ESCAPE '\\' OR assistant_text LIKE ?3 ESCAPE '\\')))
           ORDER BY updated_at DESC LIMIT ?4`,
        )
        .bind(email, before, likePattern(q), limit)
    : db
        .prepare(`SELECT ${cols} FROM conversations WHERE email = ?1 AND updated_at < ?2 ORDER BY updated_at DESC LIMIT ?3`)
        .bind(email, before, limit);
  const { results } = await stmt.all<ConversationRow>();
  return results.map(toSummary);
}

async function ownedConversation(db: D1Database, email: string, id: string): Promise<ConversationRow | null> {
  if (!isValidConversationId(id)) return null;
  return db
    .prepare(
      'SELECT id, title, model, provider, created_at, updated_at, turn_count, input_tokens, output_tokens, last_status FROM conversations WHERE id = ? AND email = ?',
    )
    .bind(id, email)
    .first<ConversationRow>();
}

async function readRecords(env: Required<HistoryEnv>, email: string, id: string): Promise<TurnRecord[]> {
  const { results } = await env.HISTORY_DB.prepare('SELECT r2_key FROM turns WHERE conversation_id = ? AND email = ? ORDER BY turn_index')
    .bind(id, email)
    .all<{ r2_key: string }>();
  const records = await Promise.all(
    results.map(async ({ r2_key }) => {
      const obj = await env.HISTORY_BUCKET.get(r2_key);
      return obj ? ((await obj.json()) as TurnRecord) : null;
    }),
  );
  return records.filter((r): r is TurnRecord => r !== null);
}

/** One turn as the chat page renders it (same fields as its ChatMessage). */
export interface HistoryTurn {
  turnIndex: number;
  startedAt: string;
  durationMs: number;
  status: TurnStatus;
  model: string;
  provider: string;
  user: { content: string; images: string[] };
  assistant: {
    content: string;
    reasoning: string;
    toolCalls: ToolCallInfo[];
    parts: MessagePart[];
    routedModel?: { model: string; reason: string | null };
    notices: string[];
    timeline: { events: TimelineEvent[]; endAt: number; startedAt: number };
  };
}

export function assetUrl(key: string): string {
  return `/api/chat/history/asset?key=${encodeURIComponent(key)}`;
}

export function toHistoryTurn(record: TurnRecord): HistoryTurn {
  const a = record.response.assistant;
  return {
    turnIndex: record.turnIndex,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    status: record.status,
    model: record.request.model,
    provider: record.request.provider,
    user: { content: record.request.userText, images: record.request.imageKeys.map(assetUrl) },
    assistant: {
      content: a.content,
      reasoning: a.reasoning,
      toolCalls: a.toolCalls,
      parts: a.parts,
      ...(a.routedModel ? { routedModel: a.routedModel } : {}),
      notices: a.notices,
      timeline: { events: record.response.timeline.events, endAt: record.response.timeline.endAt, startedAt: 0 },
    },
  };
}

export async function loadConversation(
  env: Required<HistoryEnv>,
  email: string,
  id: string,
): Promise<{ conversation: ConversationSummary; turns: HistoryTurn[] } | null> {
  const row = await ownedConversation(env.HISTORY_DB, email, id);
  if (!row) return null;
  const records = await readRecords(env, email, id);
  return { conversation: toSummary(row), turns: records.map(toHistoryTurn) };
}

export async function exportConversation(
  env: Required<HistoryEnv>,
  email: string,
  id: string,
): Promise<{ conversation: ConversationSummary; turns: TurnRecord[] } | null> {
  const row = await ownedConversation(env.HISTORY_DB, email, id);
  if (!row) return null;
  return { conversation: toSummary(row), turns: await readRecords(env, email, id) };
}

export async function renameConversation(db: D1Database, email: string, id: string, title: string): Promise<boolean> {
  const t = title.trim().slice(0, 200);
  if (!t || !isValidConversationId(id)) return false;
  const res = await db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND email = ?').bind(t, id, email).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function deleteConversation(env: Required<HistoryEnv>, email: string, id: string): Promise<boolean> {
  if (!(await ownedConversation(env.HISTORY_DB, email, id))) return false;
  const prefix = `${await userPrefix(email)}/${id}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.HISTORY_BUCKET.list({ prefix, cursor });
    if (listed.objects.length) await env.HISTORY_BUCKET.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  await env.HISTORY_DB.batch([
    env.HISTORY_DB.prepare('DELETE FROM turns WHERE conversation_id = ? AND email = ?').bind(id, email),
    env.HISTORY_DB.prepare('DELETE FROM conversations WHERE id = ? AND email = ?').bind(id, email),
  ]);
  return true;
}

/** An asset key is readable only inside the caller's own folder. */
export async function ownsAssetKey(email: string, key: string): Promise<boolean> {
  return key.startsWith(`${await userPrefix(email)}/`) && !key.includes('..') && /-image-\d+\.[a-z0-9]+$/.test(key);
}
