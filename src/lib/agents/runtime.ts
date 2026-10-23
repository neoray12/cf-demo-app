// Traced agent runtime: main agent + subagents + parallel fan-out, mirrored to the
// browser as NDJSON span events (TraceEvent). Cloudflare-side spans come from the
// `ai` namespace in RunContext (wrapped by getTracedAI()).
import { stepCountIs, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";
import type { AgentEnv } from "./env";
import { createAgentModel } from "./gateway";
import type { AgentId } from "./ids";
import { AGENT_MODELS, type ModelKey } from "./models";
import type { TraceEvent } from "./trace-events";
import { recordActiveSpanException } from "./tracing";

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
export const FIRST_PART_IDLE_MS = 150_000;
const DETAIL_MAX_CHARS = 2000;
const SPAN_INPUT_MAX_CHARS = 500;

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
  /** The model chosen for this run; subagents use it instead of their own default (set by runAgent). */
  modelKey?: ModelKey;
  /** Run-scoped shared resources (e.g. one MCP connection for all parallel subagents); disposed when the run ends. */
  scope?: RunScope;
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
  /** Span detail for the subagent's span-end; defaults to `{ output: text.slice(0, 2000) }`. */
  toDetail?(text: string): unknown;
}

export interface ToolResultRecord {
  toolName: string;
  output: unknown;
}

export interface AgentDef {
  id: AgentId;
  functionId: string;
  defaultModel: ModelKey;
  maxSteps: number;
  system(ctx: RunContext): string;
  tools(ctx: RunContext): ToolSet;
  after?(
    ctx: RunContext,
    result: { text: string; rootSpanId: string; toolResults: ToolResultRecord[] },
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

function telemetry(functionId: string, conversationId: string) {
  return {
    isEnabled: true,
    functionId,
    metadata: { agentId: `${functionId}-demo`, conversationId },
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

/**
 * Consume an AI SDK v6 `fullStream`, emitting one `chat` span per step and one
 * `execute_tool` span per tool call (both children of `parentSpanId`).
 * A tool span starts as soon as the model begins writing its arguments
 * (`tool-input-start`, whose `id` is the toolCallId), so the tool shows up live;
 * its `span-input` follows on `tool-call` (arguments complete). Tool spans / inputs
 * already emitted by `traceToolExecutions` (ids in `opts.startedToolSpans` /
 * `opts.inputToolSpans`) are not emitted again. A started tool counts as open
 * (idle timer suspended) until its span-end.
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
  },
): Promise<{ text: string; firstTokenAt?: number; toolResults: ToolResultRecord[] }> {
  const { parentSpanId, modelLabel, forwardText } = opts;
  const iterator = stream[Symbol.asyncIterator]();

  let text = "";
  let firstTokenAt: number | undefined;
  const toolResults: ToolResultRecord[] = [];
  let stepIndex = 0;
  let chat: { id: string; start: number; firstAt?: number } | null = null;
  // Tool spans: started = span-start emitted (here or by traceToolExecutions);
  // a tool is open (running) while started but not yet ended.
  const startedTools = opts.startedToolSpans ?? new Set<string>();
  const endedTools = new Set<string>();
  const inputSent = opts.inputToolSpans ?? new Set<string>();
  const toolInputs = new Map<string, unknown>();
  const openToolIds = () => [...startedTools].filter((id) => !endedTools.has(id));

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
    if (chat) ctx.emit({ type: "span-end", id: chat.id, t: ctx.now(), status: "error", detail });
    chat = null;
  };

  const handle = (part: StreamPart) => {
    switch (part.type) {
      case "start-step": {
        if (chat) ctx.emit({ type: "span-end", id: chat.id, t: ctx.now(), status: "ok" });
        const id = `${parentSpanId}:chat:${stepIndex++}`;
        const t = ctx.now();
        chat = { id, start: t };
        ctx.emit({ type: "span-start", id, parentId: parentSpanId, kind: "chat", name: modelLabel, t });
        return;
      }
      case "reasoning-delta":
      case "text-delta": {
        if (!part.text) return;
        const t = ctx.now();
        if (firstTokenAt === undefined) firstTokenAt = t;
        if (chat && chat.firstAt === undefined) chat.firstAt = t;
        if (part.type === "text-delta") text += part.text;
        if (forwardText) ctx.emit({ type: part.type, spanId: chat?.id ?? parentSpanId, text: part.text });
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
        if (!chat) return;
        const current: { id: string; start: number; firstAt?: number } = chat;
        ctx.emit({
          type: "span-end",
          id: current.id,
          t: ctx.now(),
          status: "ok",
          usage: { input: part.usage?.inputTokens ?? 0, output: part.usage?.outputTokens ?? 0 },
          ...(current.firstAt !== undefined ? { ttftMs: current.firstAt - current.start } : {}),
          ...(part.finishReason ? { detail: { finishReason: part.finishReason } } : {}),
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
    if (openToolIds().length > 0) return; // tools are running: suspended until tool-result / tool-error
    const ms = awaitingFirstPart ? FIRST_PART_IDLE_MS : STREAM_IDLE_MS;
    idleTimer = setTimeout(() => stop(idleTimeoutError()), ms);
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
  }

  // Stream ended normally: close anything the model never finished.
  for (const id of openToolIds()) endTool(id, "error", { error: "no tool result" });
  if (chat) {
    const current: { id: string; start: number; firstAt?: number } = chat;
    ctx.emit({
      type: "span-end",
      id: current.id,
      t: ctx.now(),
      status: "ok",
      ...(current.firstAt !== undefined ? { ttftMs: current.firstAt - current.start } : {}),
    });
  }

  return { text, firstTokenAt, toolResults };
}

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
 */
export async function runSubagent<I>(
  def: SubagentDef<I>,
  input: I,
  ctx: RunContext,
  parentSpanId: string,
  index: number,
): Promise<{ text: string }> {
  const id = `${parentSpanId}:${def.functionId}:${index}`;
  const link = linkedAbortController(ctx.signal);
  const subCtx: RunContext = { ...ctx, signal: link.controller.signal };
  const startedToolSpans = new Set<string>();
  const inputToolSpans = new Set<string>();
  ctx.emit({ type: "span-start", id, parentId: parentSpanId, kind: "invoke_agent", name: def.functionId, t: ctx.now() });
  try {
    const model = AGENT_MODELS[ctx.modelKey ?? def.model];
    const result = ctx.ai.streamText({
      model: createAgentModel(ctx.env, model, { functionId: def.functionId, conversationId: ctx.conversationId }),
      system: def.system,
      prompt: def.prompt(input),
      tools: traceToolExecutions(def.tools(subCtx), subCtx, id, startedToolSpans, inputToolSpans),
      stopWhen: stepCountIs(def.maxSteps),
      maxOutputTokens: model.maxTokens,
      abortSignal: subCtx.signal,
      experimental_telemetry: telemetry(def.functionId, ctx.conversationId),
    });
    const { text } = await pipeStepStream(result.fullStream, subCtx, {
      parentSpanId: id,
      modelLabel: model.key,
      forwardText: true,
      startedToolSpans,
      inputToolSpans,
    });
    const detail = def.toDetail ? smallDetail(def.toDetail(text)) : { output: text.slice(0, DETAIL_MAX_CHARS) };
    ctx.emit({ type: "span-end", id, t: ctx.now(), status: "ok", detail });
    return { text };
  } catch (err) {
    recordActiveSpanException(err);
    const aborted = ctx.signal.aborted || isAbortError(err);
    link.controller.abort();
    ctx.emit({ type: "span-end", id, t: ctx.now(), status: "error", detail: { error: aborted ? "aborted" : errorMessage(err) } });
    throw err;
  } finally {
    link.dispose();
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
  //   nothing is emitted after run-end.
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

  const emit = (e: TraceEvent) => {
    if (ended) return;
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
      case "text-delta":
      case "reasoning-delta":
        // subagent deltas are progress, not the answer's first token
        if (firstVisibleAt === undefined && (e.spanId === runId || parents.get(e.spanId) === runId)) {
          firstVisibleAt = ctx.now();
        }
        break;
      case "run-end":
        ended = true;
        break;
    }
    forward(e);
  };
  const runScope = createRunScope();
  const runCtx: RunContext = { ...ctx, emit, signal: link.controller.signal, modelKey, scope: runScope.scope };
  const startedToolSpans = new Set<string>();
  const inputToolSpans = new Set<string>();

  const t0 = ctx.now();
  emit({ type: "run-start", runId, agent: def.id, model: modelKey, t: t0 });
  emit({ type: "span-start", id: runId, kind: "invoke_agent", name: def.functionId, t: t0 });

  const finish = (status: "ok" | "error" | "aborted", error?: string) => {
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
    const result = ctx.ai.streamText({
      model: createAgentModel(ctx.env, model, { functionId: def.functionId, conversationId: ctx.conversationId }),
      system: def.system(runCtx),
      messages,
      tools: traceToolExecutions(def.tools(runCtx), runCtx, runId, startedToolSpans, inputToolSpans),
      stopWhen: stepCountIs(def.maxSteps),
      maxOutputTokens: model.maxTokens,
      abortSignal: runCtx.signal,
      experimental_telemetry: telemetry(def.functionId, ctx.conversationId),
    });
    const { text, toolResults } = await pipeStepStream(result.fullStream, runCtx, {
      parentSpanId: runId,
      modelLabel: model.key,
      forwardText: true,
      startedToolSpans,
      inputToolSpans,
    });
    await def.after?.(runCtx, { text, rootSpanId: runId, toolResults });
    emit({ type: "span-end", id: runId, t: ctx.now(), status: "ok", detail: { output: text.slice(0, DETAIL_MAX_CHARS) } });
    finish("ok");
  } catch (err) {
    recordActiveSpanException(err);
    const aborted = ctx.signal.aborted || isAbortError(err);
    const message = aborted ? "aborted" : errorMessage(err);
    link.controller.abort();
    // The root span-end closes every still-open descendant first (see emit).
    emit({ type: "span-end", id: runId, t: ctx.now(), status: "error", detail: { error: message } });
    if (aborted) finish("aborted");
    else finish("error", message);
  } finally {
    link.dispose();
    // Close run-scoped resources (shared MCP connections...) on success, error and abort alike.
    // run-end is already out; cap the wait so a stuck close can't hold the response open.
    await Promise.race([runScope.disposeAll(), new Promise<void>((r) => setTimeout(r, 2000).unref?.())]);
  }
}

