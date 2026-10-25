// Traced agent runtime: main agent + subagents + parallel fan-out, mirrored to the
// browser as NDJSON span events (TraceEvent). Cloudflare-side spans come from the
// `ai` namespace in RunContext (wrapped by getTracedAI()).
import { stepCountIs, type LanguageModel, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";
import type { AgentEnv } from "./env";
import { createAgentModel } from "./gateway";
import type { AgentId } from "./ids";
import { userLanguage, type UserLanguage } from "./language";
import { createMarkupFilter, type MarkupFilter } from "./markup-filter";
import { AGENT_MODELS, noThink, type ModelKey } from "./models";
import type { TraceEvent } from "./trace-events";
import { recordActiveSpanException, withToolSpan } from "./tracing";

export type { AgentEnv };

/**
 * Idle windows for a model stream (exceeding one is treated like an abort with
 * detail.error = "idle timeout"):
 * - STREAM_IDLE_MS between parts once a step has produced its first part;
 * - FIRST_PART_IDLE_MS while waiting for a step's first part (stream start, after
 *   `start-step`, and between `finish-step` and the next step), because reasoning
 *   models that don't stream their thinking can be silent that long;
 * - no limit while any tool of this stream is executing (v6 emits no parts
 *   between `tool-call` and `tool-result` / `tool-error`; tools enforce their own timeouts).
 */
export const STREAM_IDLE_MS = 60_000;
/** Subagents use a shorter between-parts window: they get one retry (R32), so a stalled one should fail fast. */
export const SUBAGENT_STREAM_IDLE_MS = 45_000;
export const FIRST_PART_IDLE_MS = 150_000;
const DETAIL_MAX_CHARS = 2000;
const SPAN_INPUT_MAX_CHARS = 500;
/** runAgent batches text/reasoning deltas per (span, type) and flushes them at this interval. */
export const DELTA_FLUSH_MS = 75;

export interface RunContext {
  env: AgentEnv;
  ai: typeof import("ai");
  emit(e: TraceEvent): void;
  /** Milliseconds; event `t` values come straight from here (the route makes it relative to run start). */
  now(): number;
  conversationId: string;
  storeContent: boolean;
  workspace?: string;
  signal: AbortSignal;
  /**
   * The model chosen for this run (set by runAgent). Subagents use its no-think variant (`noThink`) instead of
   * their own default: the menu's thinking choice applies to the root agent only.
   */
  modelKey?: ModelKey;
  /** Run-scoped shared state (e.g. the knowledge base's citation counter); disposed when the run ends. */
  scope?: RunScope;
  /** The run's prefetch (AgentDef.prefetch), set by runAgent before the root's tools are built; never rejects. */
  prefetched?: Promise<PrefetchResult>;
  /** Whether Cloudflare Agents tracing wraps `ai` (reported on run-start; set by the route from isTracingActive()). */
  traced?: boolean;
  /** The agent currently running (set by runAgent / runSubagent); deterministic tool spans are attributed to it. */
  agent?: { name: string; id: string };
  /** The last user message of the run (set by runAgent); subagents derive their output language from it. */
  userText?: string;
  /**
   * Model for a subagent (by its functionId), when the caller isn't on the Workers AI catalog — the main chat runs
   * its subagents on whatever model the user picked. Unset: AGENT_MODELS + createAgentModel, as in the Agents demo.
   */
  languageModel?: (functionId: string) => { model: LanguageModel; label: string; maxOutputTokens?: number };
}

/** Language of the run's user question (subagent findings are written in it). */
export function ctxLanguage(ctx: Pick<RunContext, "userText">): UserLanguage {
  return userLanguage(ctx.userText);
}

/**
 * Per-run resource registry. `once(key, create, dispose)` creates the resource on first use and returns the same
 * instance to every later caller (subagents get a spread copy of the RunContext, so the scope object is shared).
 * runAgent disposes everything in its `finally`, i.e. on success, error and abort. A `once()` that comes in after
 * that (a straggling tool) still gets a value, but it is disposed immediately instead of being stored, so it can't leak.
 */
export interface RunScope {
  once<T>(key: unknown, create: () => T, dispose: (value: T) => void | Promise<void>): T;
}

function createRunScope(): { scope: RunScope; disposeAll(): Promise<void> } {
  const entries = new Map<unknown, { value: unknown; dispose: (v: never) => void | Promise<void> }>();
  let disposed = false;
  return {
    scope: {
      once<T>(key: unknown, create: () => T, dispose: (value: T) => void | Promise<void>): T {
        const hit = entries.get(key);
        if (hit) return hit.value as T;
        const value = create();
        if (disposed) {
          try {
            void Promise.resolve(dispose(value)).catch(() => {});
          } catch {
            // best-effort close
          }
          return value;
        }
        entries.set(key, { value, dispose: dispose as (v: never) => void | Promise<void> });
        return value;
      },
    },
    async disposeAll() {
      disposed = true;
      const all = [...entries.values()];
      entries.clear();
      await Promise.allSettled(
        all.map(async (e) => {
          await e.dispose(e.value as never);
        }),
      );
    },
  };
}

/**
 * Span id of a tool call. Providers (Kimi: `functions.search_docs:0`) reuse the same toolCallId in different
 * agents, so tool spans are namespaced by the calling agent's span. The wrapper in traceToolExecutions passes
 * this id to tools as `options.toolCallId`, so citations and subagent parent ids use it too.
 */
export function toolSpanId(parentSpanId: string, toolCallId: string): string {
  return `${parentSpanId}/${toolCallId}`;
}

export interface SubagentDef<I> {
  functionId: string;
  model: ModelKey;
  system: string;
  maxSteps: number;
  tools(ctx: RunContext): ToolSet;
  prompt(input: I): string;
  /**
   * Deterministic work before the model call, inside the subagent's invoke_agent span (e.g. a search via
   * runTracedTool with `subagentSpanId` as parent). The returned text is appended to the prompt. Runs once per
   * attempt (a retry runs it again); a throw fails the attempt like a model error.
   */
  prepare?(input: I, ctx: RunContext, subagentSpanId: string): Promise<string>;
  /** Span detail for the subagent's span-end; defaults to `{ output: text.slice(0, 2000) }`. */
  toDetail?(text: string): unknown;
}

export interface ToolResultRecord {
  toolName: string;
  output: unknown;
}

/** What an agent's prefetch hands to the run. */
export interface PrefetchResult {
  /** Text added to the root's system prompt ("await" mode only). */
  context?: string;
  /** Recorded like tool results of the root: prepended to the toolResults that `after` receives. */
  toolResults?: ToolResultRecord[];
  /** Anything the agent's own tools want to read back from ctx.prefetched. */
  data?: unknown;
}

export interface AgentDef {
  id: AgentId;
  functionId: string;
  defaultModel: ModelKey;
  maxSteps: number;
  system(ctx: RunContext): string;
  tools(ctx: RunContext): ToolSet;
  /**
   * Started by runAgent right after run-start / the root span-start (t≈0), so its tool spans (runTracedTool with
   * parent `rootSpanId`) show up immediately. `userText` = the last user message. Exposed to tools as
   * ctx.prefetched. A rejection is swallowed (its span already shows the error) and becomes `{}`.
   */
  prefetch?(ctx: RunContext, rootSpanId: string, userText: string): Promise<PrefetchResult>;
  /**
   * "await": the root's first model call waits for the prefetch and gets its `context` in the system prompt.
   * "background" (default): the model call starts at once; runAgent awaits the prefetch before `after`/run-end.
   */
  prefetchMode?: "await" | "background";
  /**
   * Runs after the root stream. `text` = every root step's text glued together; `finalText` = the text of the last
   * root chat step that wrote any (trimmed) — the answer without a plan sentence written before the tool calls
   * (same rule as the UI's historyAnswer). `finalFinishReason` = the finish reason of the LAST root step
   * ("stop", "tool-calls" when the step limit cut the run off while it was still calling tools, …; undefined when
   * no step finished).
   */
  after?(
    ctx: RunContext,
    result: {
      text: string;
      finalText: string;
      finalFinishReason?: string;
      rootSpanId: string;
      toolResults: ToolResultRecord[];
    },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// helpers

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function idleTimeoutError(): Error {
  const e = new Error("idle timeout");
  e.name = "TimeoutError";
  return e;
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/** Short, serialisable error message; never the Error object itself. */
export function errorMessage(err: unknown): string {
  let msg: string;
  if (err instanceof Error) msg = err.message || err.name;
  else if (typeof err === "string") msg = err;
  else if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
    msg = (err as { message: string }).message;
  } else {
    try {
      msg = JSON.stringify(err) ?? String(err);
    } catch {
      msg = String(err);
    }
  }
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}

/** JSON-safe, size-bounded copy of a value for span detail. */
function smallDetail(value: unknown, max = DETAIL_MAX_CHARS): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  let s: string | undefined;
  try {
    s = JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  if (s === undefined) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : JSON.parse(s);
}

function clipString(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Tool arguments for `span-input`: a JSON-safe copy (via smallDetail's JSON round-trip) with every string
 * clipped to ≤ SPAN_INPUT_MAX_CHARS; if the whole thing is still large (huge arrays), its JSON text clipped instead.
 */
function spanInputValue(value: unknown): unknown {
  const safe = smallDetail(value, Number.POSITIVE_INFINITY);
  if (safe === undefined) return null;
  const clip = (v: unknown): unknown => {
    if (typeof v === "string") return clipString(v, SPAN_INPUT_MAX_CHARS);
    if (Array.isArray(v)) return v.map(clip);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
    return v;
  };
  const clipped = clip(safe);
  const json = JSON.stringify(clipped);
  return json.length > DETAIL_MAX_CHARS ? clipString(json, SPAN_INPUT_MAX_CHARS) : clipped;
}

/** experimental_telemetry for a streamText call (spec §6.4): agentId, conversationId, model key, workspace when set. */
function telemetry(functionId: string, ctx: RunContext, modelKey: string) {
  return {
    isEnabled: true,
    functionId,
    metadata: {
      agentId: `${functionId}-demo`,
      conversationId: ctx.conversationId,
      model: modelKey,
      ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// stream → span events

type StreamPart = TextStreamPart<ToolSet>;

/**
 * Wrap every tool's `execute` so its `execute_tool` span-start (id = toolCallId,
 * parent = `parentSpanId`, i.e. the calling agent's span — the same parent
 * pipeStepStream uses) and its `span-input` are emitted *before* the tool runs.
 * In ai@6 the tool starts executing before its `tool-call` part reaches the
 * fullStream consumer, so without this, subagents started inside `execute` would
 * be emitted before their parent tool span. `started` / `inputs` are shared with
 * pipeStepStream (opts `startedToolSpans` / `inputToolSpans`), so whichever side
 * comes first emits the span-start and the span-input, exactly once each;
 * pipeStepStream still emits the single span-end on tool-result / tool-error.
 */
function traceToolExecutions(
  tools: ToolSet,
  ctx: RunContext,
  parentSpanId: string,
  started: Set<string>,
  inputs: Set<string>,
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute as ((input: unknown, options: { toolCallId: string }) => unknown) | undefined;
    if (typeof execute !== "function") {
      wrapped[name] = t;
      continue;
    }
    wrapped[name] = {
      ...t,
      execute: (input: unknown, options: { toolCallId: string }) => {
        const rawId = options?.toolCallId;
        if (!rawId) return execute.call(t, input, options);
        const id = toolSpanId(parentSpanId, rawId);
        if (!started.has(id)) {
          started.add(id);
          ctx.emit({ type: "span-start", id, parentId: parentSpanId, kind: "execute_tool", name, t: ctx.now() });
        }
        if (!inputs.has(id)) {
          inputs.add(id);
          ctx.emit({ type: "span-input", id, input: spanInputValue(input) });
        }
        return execute.call(t, input, { ...options, toolCallId: id });
      },
    } as typeof t;
  }
  return wrapped;
}

interface ChatSpan {
  id: string;
  start: number;
  firstAt?: number;
  ended: boolean;
}

/**
 * The chat spans (one per step, id `${parentSpanId}:chat:${n}`) of one agent stream.
 * `request(n)` is called from streamText's `prepareStep`, i.e. right before step n's
 * HTTP request goes out, so the span (and its timer in the UI) covers upstream
 * queueing / time-to-first-byte; pipeStepStream adopts it on that step's `start-step`
 * (or opens it there when nothing requested it, e.g. fake streams). Step n+1 may be
 * requested before the consumer has read step n's `finish-step`, so spans are kept
 * per step rather than as a single "current" one.
 */
export interface ChatSpans {
  request(stepNumber: number): void;
}

interface ChatSpanTracker extends ChatSpans {
  open(stepNumber: number): ChatSpan;
  end(span: ChatSpan, status: "ok" | "error", extra?: { usage?: { input: number; output: number }; detail?: unknown }): void;
  openSpans(): ChatSpan[];
  /** Called after a span is opened by `request` (pipeStepStream re-arms its first-part idle window). */
  onRequest?: () => void;
  /** After the stream is done, late requests are ignored. */
  close(): void;
}

function createChatSpans(ctx: RunContext, parentSpanId: string, modelLabel: string): ChatSpanTracker {
  const spans = new Map<number, ChatSpan>();
  let closed = false;
  const tracker: ChatSpanTracker = {
    open(n) {
      const hit = spans.get(n);
      if (hit) return hit;
      const span: ChatSpan = { id: `${parentSpanId}:chat:${n}`, start: ctx.now(), ended: false };
      spans.set(n, span);
      ctx.emit({ type: "span-start", id: span.id, parentId: parentSpanId, kind: "chat", name: modelLabel, t: span.start });
      return span;
    },
    request(n) {
      if (closed || spans.has(n)) return;
      tracker.open(n);
      tracker.onRequest?.();
    },
    end(span, status, extra) {
      if (span.ended) return;
      span.ended = true;
      ctx.emit({
        type: "span-end",
        id: span.id,
        t: ctx.now(),
        status,
        ...(extra?.usage ? { usage: extra.usage } : {}),
        ...(span.firstAt !== undefined ? { ttftMs: span.firstAt - span.start } : {}),
        ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
      });
    },
    openSpans: () => [...spans.values()].filter((sp) => !sp.ended),
    close() {
      closed = true;
      tracker.onRequest = undefined;
    },
  };
  return tracker;
}

/**
 * Consume an AI SDK v6 `fullStream`, emitting one `chat` span per step and one
 * `execute_tool` span per tool call (both children of `parentSpanId`).
 * - Chat spans come from `opts.chatSpans` when the caller wires its `request` into
 *   `prepareStep` (opened at request time; `ttftMs` = first delta − request time);
 *   otherwise they open on `start-step`.
 * - A tool span starts as soon as the model begins writing its arguments
 *   (`tool-input-start`, whose `id` is the toolCallId), so the tool shows up live;
 *   its `span-input` follows on `tool-call` (arguments complete) or from the execute
 *   wrapper, whichever is first. Tool spans / inputs already emitted by
 *   `traceToolExecutions` (ids in `opts.startedToolSpans` / `opts.inputToolSpans`)
 *   are not emitted again.
 * - A tool is "running" (idle timer suspended) once its arguments are complete
 *   (span-input sent) until its span-end. While its arguments are still streaming
 *   ("input phase") the normal idle window applies, and a tool still in input phase
 *   at its step's `finish-step` is closed with "incomplete tool arguments".
 * On abort / idle timeout / stream error, every span still open is closed with
 * `status: "error"` and `detail: { error }`, then the error is rethrown
 * (abort → an `AbortError`).
 */
export async function pipeStepStream(
  stream: AsyncIterable<StreamPart>,
  ctx: RunContext,
  opts: {
    parentSpanId: string;
    modelLabel: string;
    forwardText: boolean;
    startedToolSpans?: Set<string>;
    inputToolSpans?: Set<string>;
    chatSpans?: ChatSpans;
    /** Between-parts idle window (default STREAM_IDLE_MS); the first-part window is always FIRST_PART_IDLE_MS. */
    idleMs?: number;
  },
): Promise<{
  text: string;
  finalText: string;
  /** finishReason of the last finished step. */
  finalFinishReason?: string;
  firstTokenAt?: number;
  toolResults: ToolResultRecord[];
}> {
  const { parentSpanId, modelLabel, forwardText } = opts;
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
  const iterator = stream[Symbol.asyncIterator]();

  let text = "";
  // Text per chat span, in step order (finalText = the last step that wrote any).
  const stepTexts = new Map<string, string>();
  let firstTokenAt: number | undefined;
  let finalFinishReason: string | undefined;
  const toolResults: ToolResultRecord[] = [];
  const chats = (opts.chatSpans as ChatSpanTracker | undefined) ?? createChatSpans(ctx, parentSpanId, modelLabel);
  let stepIndex = 0;
  let chat: ChatSpan | null = null; // the step whose parts are being consumed
  // Tool spans: started = span-start emitted (here or by traceToolExecutions); ended = span-end emitted;
  // inputSent = arguments complete (span-input emitted). Running = started, input sent, not ended.
  const startedTools = opts.startedToolSpans ?? new Set<string>();
  const endedTools = new Set<string>();
  const inputSent = opts.inputToolSpans ?? new Set<string>();
  const toolInputs = new Map<string, unknown>();
  const openToolIds = () => [...startedTools].filter((id) => !endedTools.has(id));
  const runningToolIds = () => openToolIds().filter((id) => inputSent.has(id));
  const inputPhaseToolIds = () => openToolIds().filter((id) => !inputSent.has(id));

  const ensureToolStarted = (rawToolCallId: string, toolName: string) => {
    const toolCallId = toolSpanId(parentSpanId, rawToolCallId);
    if (startedTools.has(toolCallId)) return;
    startedTools.add(toolCallId);
    ctx.emit({ type: "span-start", id: toolCallId, parentId: parentSpanId, kind: "execute_tool", name: toolName, t: ctx.now() });
  };
  const emitInput = (rawToolCallId: string, input: unknown) => {
    const id = toolSpanId(parentSpanId, rawToolCallId);
    if (inputSent.has(id) || endedTools.has(id)) return;
    inputSent.add(id);
    ctx.emit({ type: "span-input", id, input: spanInputValue(input) });
  };
  const endTool = (toolCallId: string, status: "ok" | "error", detail: unknown) => {
    if (endedTools.has(toolCallId)) return;
    endedTools.add(toolCallId);
    ctx.emit({ type: "span-end", id: toolCallId, t: ctx.now(), status, detail });
  };

  const closeOpenSpans = (detail: { error: string }) => {
    for (const id of openToolIds()) endTool(id, "error", detail);
    for (const span of chats.openSpans()) chats.end(span, "error", { detail });
    chat = null;
  };

  // Leaked Kimi tool-call markup is stripped from every delta (one stateful filter per span and delta type, so
  // markup split across chunks is caught); a step's filters are flushed before its chat span ends.
  type DeltaType = "text-delta" | "reasoning-delta";
  const filters = new Map<string, { type: DeltaType; spanId: string; span: ChatSpan | null; filter: MarkupFilter }>();
  const deliver = (type: DeltaType, spanId: string, span: ChatSpan | null, chunk: string) => {
    if (!chunk) return;
    const t = ctx.now();
    if (firstTokenAt === undefined) firstTokenAt = t;
    if (span && span.firstAt === undefined) span.firstAt = t;
    if (type === "text-delta") {
      text += chunk;
      stepTexts.set(spanId, (stepTexts.get(spanId) ?? "") + chunk);
    }
    if (forwardText) ctx.emit({ type, spanId, text: chunk });
  };
  const pushDelta = (type: DeltaType, raw: string) => {
    const spanId = chat?.id ?? parentSpanId;
    const key = `${type}\u0000${spanId}`;
    let entry = filters.get(key);
    if (!entry) {
      entry = { type, spanId, span: chat, filter: createMarkupFilter() };
      filters.set(key, entry);
    }
    deliver(type, spanId, chat, entry.filter.push(raw));
  };
  const flushDeltas = (spanId?: string) => {
    for (const [key, e] of filters) {
      if (spanId !== undefined && e.spanId !== spanId) continue;
      filters.delete(key);
      deliver(e.type, e.spanId, e.span, e.filter.flush());
    }
  };

  const handle = (part: StreamPart) => {
    switch (part.type) {
      case "start-step": {
        if (chat) {
          flushDeltas(chat.id);
          chats.end(chat, "ok");
        }
        chat = chats.open(stepIndex++);
        return;
      }
      case "reasoning-delta":
      case "text-delta": {
        if (!part.text) return;
        pushDelta(part.type, part.text);
        return;
      }
      case "tool-input-start": {
        // v6: `id` is the toolCallId of the upcoming tool-call (openai-compatible chat provider).
        ensureToolStarted(part.id, part.toolName);
        return;
      }
      case "tool-call": {
        toolInputs.set(toolSpanId(parentSpanId, part.toolCallId), part.input);
        ensureToolStarted(part.toolCallId, part.toolName);
        emitInput(part.toolCallId, part.input);
        return;
      }
      case "tool-result": {
        if (part.preliminary) return;
        const id = toolSpanId(parentSpanId, part.toolCallId);
        ensureToolStarted(part.toolCallId, part.toolName);
        const input = toolInputs.has(id) ? toolInputs.get(id) : part.input;
        toolResults.push({ toolName: part.toolName, output: part.output });
        endTool(id, "ok", { input: smallDetail(input, 500), output: smallDetail(part.output) });
        return;
      }
      case "tool-error": {
        ensureToolStarted(part.toolCallId, part.toolName);
        endTool(toolSpanId(parentSpanId, part.toolCallId), "error", { error: errorMessage(part.error) });
        return;
      }
      case "tool-output-denied": {
        const id = toolSpanId(parentSpanId, part.toolCallId);
        if (!startedTools.has(id)) return;
        endTool(id, "error", { error: "denied" });
        return;
      }
      case "finish-step": {
        // the provider only emits tool-call once the arguments parse; anything still streaming is dead
        for (const id of inputPhaseToolIds()) endTool(id, "error", { error: "incomplete tool arguments" });
        if (!chat) return;
        flushDeltas(chat.id);
        if (part.finishReason) finalFinishReason = part.finishReason;
        // gateway.ts marks hedged requests on the response (x-agents-hedge*); finish-step carries its headers
        const headers = (part as { response?: { headers?: Record<string, string> } }).response?.headers;
        const hedge =
          headers?.["x-agents-hedge-fired"] === "1" ? { hedge: { fired: true, winner: headers["x-agents-hedge"] ?? "?" } } : {};
        const detail = { ...(part.finishReason ? { finishReason: part.finishReason } : {}), ...hedge };
        chats.end(chat, "ok", {
          usage: { input: part.usage?.inputTokens ?? 0, output: part.usage?.outputTokens ?? 0 },
          ...(Object.keys(detail).length > 0 ? { detail } : {}),
        });
        chat = null;
        return;
      }
      case "error":
        throw new Error(errorMessage(part.error));
      case "abort":
        throw abortError();
      default:
        return;
    }
  };

  // Rejects on abort or idle timeout; raced against every iterator.next().
  let stop!: (err: Error) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => {});
  const onAbort = () => stop(abortError());
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let awaitingFirstPart = true;
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (runningToolIds().length > 0) return; // tools are executing: suspended until tool-result / tool-error
    const ms = awaitingFirstPart ? FIRST_PART_IDLE_MS : idleMs;
    idleTimer = setTimeout(() => stop(idleTimeoutError()), ms);
  };
  // A step's first-part window starts when its request goes out (chat span start).
  chats.onRequest = () => {
    if (awaitingFirstPart) armIdle();
  };

  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    armIdle();
    for (;;) {
      const next = iterator.next();
      next.catch(() => {});
      const r = await Promise.race([next, stopped]);
      if (ctx.signal.aborted) throw abortError();
      if (r.done) break;
      handle(r.value);
      const type = r.value.type;
      if (type === "start-step" || type === "finish-step") awaitingFirstPart = true;
      else if (type !== "start") awaitingFirstPart = false;
      armIdle();
    }
  } catch (err) {
    const aborted = ctx.signal.aborted || isAbortError(err);
    closeOpenSpans({ error: aborted ? "aborted" : errorMessage(err) });
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    } catch {
      // ignore: best-effort cancellation of the underlying stream
    }
    throw aborted && !isAbortError(err) ? abortError() : err;
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    ctx.signal.removeEventListener("abort", onAbort);
    chats.close();
  }

  // Stream ended normally: close anything the model never finished.
  flushDeltas();
  for (const id of openToolIds()) endTool(id, "error", { error: "no tool result" });
  for (const span of chats.openSpans()) chats.end(span, "ok");

  const steps = [...stepTexts.values()].map((s) => s.trim()).filter((s) => s !== "");
  return { text, finalText: steps.at(-1) ?? text.trim(), finalFinishReason, firstTokenAt, toolResults };
}

/**
 * prepareStep for an agent stream: opens step n's chat span when its request goes out (R22) and, on the last
 * allowed step, disables tools so the model has to write its answer / finding (R23).
 */
function stepPreparer(chatSpans: ChatSpans, maxSteps: number, finalStepNote?: string) {
  return ({ stepNumber, messages }: { stepNumber: number; messages?: ModelMessage[] }) => {
    chatSpans.request(stepNumber);
    if (stepNumber < maxSteps - 1) return {};
    const last = { toolChoice: "none" as const, activeTools: [] as never[] };
    // Subagents: after a tool round, say so explicitly — with tools merely disabled, Kimi tends to "call" one
    // anyway by writing raw tool-call markup as its finding.
    if (finalStepNote && stepNumber > 0 && messages) {
      return { ...last, messages: [...messages, { role: "user" as const, content: finalStepNote }] };
    }
    return last;
  };
}

/** R23 for subagents: the prompt of a forced final step (after at least one tool round). */
export const SUBAGENT_FINAL_STEP_NOTE =
  "This is your final step and tools are now disabled. Do not call or write out any tool call. Write your finding now, using only what the tool results above contain (keep their source URLs); if something was not found, say so.";

// ---------------------------------------------------------------------------
// subagents & fan-out

/** AbortController that aborts when `parent` does; `dispose()` detaches the listener. */
function linkedAbortController(parent: AbortSignal): { controller: AbortController; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", onAbort, { once: true });
  return { controller, dispose: () => parent.removeEventListener("abort", onAbort) };
}

/**
 * Run a subagent as a child `invoke_agent` span of `parentSpanId` (normally the
 * calling tool's toolCallId). Its reasoning/text deltas are forwarded under its
 * own chat span ids, as live progress (the reducer keeps them out of the answer).
 * The subagent runs on a child AbortSignal (linked to `ctx.signal`) that is also
 * aborted on its own failure (idle timeout, stream error) so its model request
 * and tools are cancelled without touching siblings.
 *
 * One-shot retry (R32): when an attempt fails for any reason other than an abort
 * (idle timeout, stream error), it is retried once as a new `invoke_agent` span
 * `…:${index}r` under the same parent; the failed span stays "error". The retry's
 * result is returned; if it fails too, its error is thrown. (The root agent never
 * retries: its text has already been streamed to the user.)
 */
export async function runSubagent<I>(
  def: SubagentDef<I>,
  input: I,
  ctx: RunContext,
  parentSpanId: string,
  index: number,
): Promise<{ text: string }> {
  try {
    return await runSubagentAttempt(def, input, ctx, parentSpanId, String(index));
  } catch (err) {
    if (ctx.signal.aborted || isAbortError(err)) throw err;
    return runSubagentAttempt(def, input, ctx, parentSpanId, `${index}r`);
  }
}

function resolveSubagentModel<I>(
  def: SubagentDef<I>,
  ctx: RunContext,
): { model: LanguageModel; label: string; maxOutputTokens?: number } {
  if (ctx.languageModel) return ctx.languageModel(def.functionId);
  // Subagents never think: the menu's thinking choice applies to the root only.
  const model = AGENT_MODELS[noThink(ctx.modelKey ?? def.model)];
  return {
    model: createAgentModel(ctx.env, model, { functionId: def.functionId, conversationId: ctx.conversationId }),
    label: model.key,
    maxOutputTokens: model.maxTokens,
  };
}

async function runSubagentAttempt<I>(
  def: SubagentDef<I>,
  input: I,
  ctx: RunContext,
  parentSpanId: string,
  index: string,
): Promise<{ text: string }> {
  const id = `${parentSpanId}:${def.functionId}:${index}`;
  const link = linkedAbortController(ctx.signal);
  const subCtx: RunContext = {
    ...ctx,
    signal: link.controller.signal,
    agent: { name: def.functionId, id: `${def.functionId}-demo` },
  };
  const startedToolSpans = new Set<string>();
  const inputToolSpans = new Set<string>();
  ctx.emit({ type: "span-start", id, parentId: parentSpanId, kind: "invoke_agent", name: def.functionId, t: ctx.now() });
  try {
    const resolved = resolveSubagentModel(def, ctx);
    const prepared = def.prepare ? await def.prepare(input, subCtx, id) : "";
    if (subCtx.signal.aborted) throw abortError();
    const prompt = prepared ? `${def.prompt(input)}\n\n${prepared}` : def.prompt(input);
    const chatSpans = createChatSpans(subCtx, id, resolved.label);
    const result = ctx.ai.streamText({
      model: resolved.model,
      system: def.system,
      prompt,
      tools: traceToolExecutions(def.tools(subCtx), subCtx, id, startedToolSpans, inputToolSpans),
      prepareStep: stepPreparer(chatSpans, def.maxSteps, SUBAGENT_FINAL_STEP_NOTE),
      stopWhen: stepCountIs(def.maxSteps),
      ...(resolved.maxOutputTokens ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
      abortSignal: subCtx.signal,
      experimental_telemetry: telemetry(def.functionId, ctx, resolved.label),
    });
    const { text } = await pipeStepStream(result.fullStream, subCtx, {
      parentSpanId: id,
      modelLabel: resolved.label,
      forwardText: true,
      startedToolSpans,
      inputToolSpans,
      chatSpans,
      idleMs: SUBAGENT_STREAM_IDLE_MS,
    });
    const detail = def.toDetail ? smallDetail(def.toDetail(text)) : { output: text.slice(0, DETAIL_MAX_CHARS) };
    ctx.emit({ type: "span-end", id, t: ctx.now(), status: "ok", detail });
    return { text };
  } catch (err) {
    const aborted = ctx.signal.aborted || isAbortError(err);
    // A user stop (or the run being cancelled) is not an exception; idle timeouts and real errors are.
    if (!aborted) recordActiveSpanException(err);
    link.controller.abort();
    ctx.emit({ type: "span-end", id, t: ctx.now(), status: "error", detail: { error: aborted ? "aborted" : errorMessage(err) } });
    throw err;
  } finally {
    link.dispose();
  }
}

/**
 * Run a deterministic tool call (not chosen by the model) as an `execute_tool` span under `parentSpanId`:
 * span-start + span-input are emitted synchronously (the chip shows up at once), then `fn(spanId)` runs inside a
 * Cloudflare custom span (withToolSpan) so it also appears in the dashboard's Agents trace, then span-end with
 * `{ input, output }` (same shape as model tool calls) or `{ error }`. The span id is namespaced like toolSpanId:
 * `${parentSpanId}/${callId}` (callId defaults to `${name}-{random}`). `failed(result)` may turn a result that
 * carries an error into an error span (the result is still returned); a throw is rethrown after the span-end.
 */
export async function runTracedTool<T>(
  ctx: RunContext,
  parentSpanId: string,
  name: string,
  input: unknown,
  fn: (spanId: string) => Promise<T>,
  opts: { callId?: string; failed?: (result: T) => string | undefined } = {},
): Promise<T> {
  const id = toolSpanId(parentSpanId, opts.callId ?? `${name}-${crypto.randomUUID().slice(0, 8)}`);
  ctx.emit({ type: "span-start", id, parentId: parentSpanId, kind: "execute_tool", name, t: ctx.now() });
  ctx.emit({ type: "span-input", id, input: spanInputValue(input) });
  try {
    if (ctx.signal.aborted) throw abortError();
    const result = await withToolSpan(
      { name, callId: id, input, storeContent: ctx.storeContent, agent: ctx.agent, conversationId: ctx.conversationId },
      () => fn(id),
    );
    const error = opts.failed?.(result);
    ctx.emit({
      type: "span-end",
      id,
      t: ctx.now(),
      status: error ? "error" : "ok",
      detail: { input: smallDetail(input, 500), ...(error ? { error } : {}), output: smallDetail(result) },
    });
    return result;
  } catch (err) {
    const aborted = ctx.signal.aborted || isAbortError(err);
    ctx.emit({ type: "span-end", id, t: ctx.now(), status: "error", detail: { error: aborted ? "aborted" : errorMessage(err) } });
    throw err;
  }
}

/** Run tasks concurrently; failures are collected (never thrown) so one bad subagent can't sink the rest. */
export async function runParallel<T>(
  tasks: Array<{ name: string; run(): Promise<T> }>,
): Promise<{ ok: Array<{ name: string; value: T }>; failed: Array<{ name: string; error: string }> }> {
  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const ok: Array<{ name: string; value: T }> = [];
  const failed: Array<{ name: string; error: string }> = [];
  settled.forEach((s, i) => {
    const name = tasks[i]!.name;
    if (s.status === "fulfilled") ok.push({ name, value: s.value });
    else failed.push({ name, error: errorMessage(s.reason) });
  });
  return { ok, failed };
}

// ---------------------------------------------------------------------------
// main agent

/** Text of the last user message (string content, or its text parts joined). */
export function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
  }
  return "";
}

/**
 * Run one agent turn: `run-start` → root `invoke_agent` span (id = runId) →
 * streamed chat/tool spans → `def.after` → root `span-end` → `run-end`.
 * Never rejects: failures are reported as `run-end` with status "error" / "aborted".
 */
export async function runAgent(
  def: AgentDef,
  messages: ModelMessage[],
  modelKey: ModelKey,
  ctx: RunContext,
): Promise<void> {
  const runId = crypto.randomUUID();
  const model = AGENT_MODELS[modelKey];

  // Run-scoped cancellation: linked to ctx.signal and also aborted when the run
  // fails (idle timeout, stream error, after() failure) so the model request and
  // any running subagents/tools stop too.
  const link = linkedAbortController(ctx.signal);

  // Per-run event wrapper:
  // - sums usage over every chat span (incl. subagents that use runCtx) and records
  //   when the first delta of the answer (a root-agent chat span) reached the client;
  // - keeps the span tree well-formed: a span-end first closes any still-open
  //   descendants (innermost first), duplicate/late span events are dropped, and
  //   nothing is emitted after run-end;
  // - coalesces text/reasoning deltas: one pending delta per (spanId, type), flushed
  //   every DELTA_FLUSH_MS and synchronously before any other event (so deltas never
  //   move across a span-start / span-end / span-input / run-end); deltas for spans
  //   that aren't open are dropped.
  const chatSpans = new Set<string>();
  const usage = { input: 0, output: 0 };
  let firstVisibleAt: number | undefined;
  const parents = new Map<string, string | undefined>();
  const open = new Set<string>();
  let ended = false;

  const forward = (e: TraceEvent) => {
    try {
      ctx.emit(e);
    } catch {
      // a closed client stream must not turn into a run failure; ctx.signal handles disconnects
    }
  };
  const depth = (id: string): number => {
    let d = 0;
    for (let cur = parents.get(id); cur !== undefined && d < 64; cur = parents.get(cur)) d++;
    return d;
  };
  const isDescendant = (id: string, ancestor: string): boolean => {
    let guard = 0;
    for (let cur = parents.get(id); cur !== undefined && guard < 64; cur = parents.get(cur), guard++) {
      if (cur === ancestor) return true;
    }
    return false;
  };
  // Closing the root sweeps every other open span: a subagent may have started
  // (parent = toolCallId) before its tool's span-start reached us.
  const closeDescendants = (ancestor: string, t: number, detail: { error: string }) => {
    const victims = [...open]
      .filter((id) => id !== ancestor && (ancestor === runId || isDescendant(id, ancestor)))
      .sort((a, b) => depth(b) - depth(a));
    for (const id of victims) {
      open.delete(id);
      forward({ type: "span-end", id, t, status: "error", detail });
    }
  };

  type Delta = Extract<TraceEvent, { type: "text-delta" | "reasoning-delta" }>;
  const pendingDeltas = new Map<string, Delta>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flushDeltas = () => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (pendingDeltas.size === 0) return;
    const batch = [...pendingDeltas.values()];
    pendingDeltas.clear();
    for (const d of batch) forward(d);
  };

  const emit = (e: TraceEvent) => {
    if (ended) return;
    if (e.type === "text-delta" || e.type === "reasoning-delta") {
      if (!open.has(e.spanId)) return;
      // the answer = chat spans of the root agent (same rule as reduceTrace); measured on the raw delta
      if (firstVisibleAt === undefined && chatSpans.has(e.spanId) && parents.get(e.spanId) === runId) {
        firstVisibleAt = ctx.now();
      }
      const key = `${e.type}\u0000${e.spanId}`;
      const pending = pendingDeltas.get(key);
      if (pending) pending.text += e.text;
      else pendingDeltas.set(key, { ...e });
      flushTimer ??= setTimeout(flushDeltas, DELTA_FLUSH_MS);
      return;
    }
    flushDeltas();
    switch (e.type) {
      case "span-start":
        // drop duplicates and late starts under an already-closed parent
        if (open.has(e.id) || (e.parentId !== undefined && parents.has(e.parentId) && !open.has(e.parentId))) return;
        parents.set(e.id, e.parentId);
        open.add(e.id);
        if (e.kind === "chat") chatSpans.add(e.id);
        break;
      case "span-end": {
        if (!open.has(e.id)) return;
        const err = (e.detail as { error?: unknown } | undefined)?.error;
        closeDescendants(e.id, e.t, {
          error: e.status === "error" && typeof err === "string" ? err : "parent span ended",
        });
        open.delete(e.id);
        if (e.usage && chatSpans.has(e.id)) {
          usage.input += e.usage.input;
          usage.output += e.usage.output;
        }
        break;
      }
      case "span-input":
        if (!open.has(e.id)) return;
        break;
      case "run-end":
        ended = true;
        break;
    }
    forward(e);
  };
  const runScope = createRunScope();
  const runCtx: RunContext = {
    ...ctx,
    emit,
    signal: link.controller.signal,
    modelKey,
    scope: runScope.scope,
    agent: { name: def.functionId, id: `${def.functionId}-demo` },
    userText: lastUserText(messages),
  };
  const startedToolSpans = new Set<string>();
  const inputToolSpans = new Set<string>();

  const t0 = ctx.now();
  emit({
    type: "run-start",
    runId,
    agent: def.id,
    model: modelKey,
    t: t0,
    ...(ctx.traced !== undefined ? { traced: ctx.traced } : {}),
  });
  emit({ type: "span-start", id: runId, kind: "invoke_agent", name: def.functionId, t: t0 });

  // Prefetch at t≈0: called synchronously so its tool span-start precedes the first chat span.
  let prefetch: Promise<PrefetchResult> | undefined;
  if (def.prefetch) {
    let p: Promise<PrefetchResult>;
    try {
      p = def.prefetch(runCtx, runId, lastUserText(messages));
    } catch (err) {
      p = Promise.reject(err);
    }
    prefetch = p.then((r) => r ?? {}).catch(() => ({}));
    runCtx.prefetched = prefetch;
  }

  const finish =(status: "ok" | "error" | "aborted", error?: string) => {
    const t = ctx.now();
    emit({
      type: "run-end",
      t,
      totalMs: t - t0,
      ttftMs: firstVisibleAt !== undefined ? firstVisibleAt - t0 : 0,
      usage: { ...usage },
      status,
      ...(error !== undefined ? { error } : {}),
    });
  };

  try {
    let system = def.system(runCtx);
    if (prefetch && def.prefetchMode === "await") {
      const pre = await prefetch;
      if (runCtx.signal.aborted) throw abortError();
      if (pre.context) system = `${system}\n\n${pre.context}`;
    }
    const chatSpans = createChatSpans(runCtx, runId, model.key);
    const result = ctx.ai.streamText({
      model: createAgentModel(ctx.env, model, { functionId: def.functionId, conversationId: ctx.conversationId }),
      system,
      messages,
      tools: traceToolExecutions(def.tools(runCtx), runCtx, runId, startedToolSpans, inputToolSpans),
      prepareStep: stepPreparer(chatSpans, def.maxSteps),
      stopWhen: stepCountIs(def.maxSteps),
      maxOutputTokens: model.maxTokens,
      abortSignal: runCtx.signal,
      experimental_telemetry: telemetry(def.functionId, ctx, modelKey),
    });
    const { text, finalText, finalFinishReason, toolResults } = await pipeStepStream(result.fullStream, runCtx, {
      parentSpanId: runId,
      modelLabel: model.key,
      forwardText: true,
      startedToolSpans,
      inputToolSpans,
      chatSpans,
    });
    // A background prefetch the model never asked for still finishes inside the run (its span and citations).
    const pre = prefetch ? await prefetch : {};
    if (runCtx.signal.aborted) throw abortError();
    await def.after?.(runCtx, {
      text,
      finalText,
      ...(finalFinishReason !== undefined ? { finalFinishReason } : {}),
      rootSpanId: runId,
      toolResults: [...(pre.toolResults ?? []), ...toolResults],
    });
    emit({ type: "span-end", id: runId, t: ctx.now(), status: "ok", detail: { output: text.slice(0, DETAIL_MAX_CHARS) } });
    finish("ok");
  } catch (err) {
    const aborted = ctx.signal.aborted || isAbortError(err);
    // A user stop is not an exception on the Cloudflare span; idle timeouts and real errors are.
    if (!aborted) recordActiveSpanException(err);
    const message = aborted ? "aborted" : errorMessage(err);
    link.controller.abort();
    // The root span-end closes every still-open descendant first (see emit).
    emit({ type: "span-end", id: runId, t: ctx.now(), status: "error", detail: { error: message } });
    if (aborted) finish("aborted");
    else finish("error", message);
  } finally {
    link.dispose();
    // Close run-scoped resources on success, error and abort alike.
    // run-end is already out; cap the wait so a stuck close can't hold the response open.
    await Promise.race([runScope.disposeAll(), new Promise<void>((r) => setTimeout(r, 2000).unref?.())]);
  }
}

