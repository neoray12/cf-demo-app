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

/** A model stream with no part for this long is treated like an abort (detail.error = "idle timeout"). */
export const STREAM_IDLE_MS = 60_000;
const DETAIL_MAX_CHARS = 2000;

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
 * Consume an AI SDK v6 `fullStream`, emitting one `chat` span per step and one
 * `execute_tool` span per tool call (both children of `parentSpanId`).
 * On abort / idle timeout / stream error, every span still open is closed with
 * `status: "error"` and `detail: { error }`, then the error is rethrown
 * (abort → an `AbortError`).
 */
export async function pipeStepStream(
  stream: AsyncIterable<StreamPart>,
  ctx: RunContext,
  opts: { parentSpanId: string; modelLabel: string; forwardText: boolean },
): Promise<{ text: string; firstTokenAt?: number; toolResults: ToolResultRecord[] }> {
  const { parentSpanId, modelLabel, forwardText } = opts;
  const iterator = stream[Symbol.asyncIterator]();

  let text = "";
  let firstTokenAt: number | undefined;
  const toolResults: ToolResultRecord[] = [];
  let stepIndex = 0;
  let chat: { id: string; start: number; firstAt?: number } | null = null;
  const openTools = new Map<string, { input: unknown }>();

  const startTool = (toolCallId: string, toolName: string, input: unknown) => {
    openTools.set(toolCallId, { input });
    ctx.emit({ type: "span-start", id: toolCallId, parentId: parentSpanId, kind: "execute_tool", name: toolName, t: ctx.now() });
  };

  const closeOpenSpans = (detail: { error: string }) => {
    const t = ctx.now();
    for (const id of openTools.keys()) ctx.emit({ type: "span-end", id, t, status: "error", detail });
    openTools.clear();
    if (chat) ctx.emit({ type: "span-end", id: chat.id, t, status: "error", detail });
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
      case "tool-call": {
        startTool(part.toolCallId, part.toolName, part.input);
        return;
      }
      case "tool-result": {
        if (part.preliminary) return;
        if (!openTools.has(part.toolCallId)) startTool(part.toolCallId, part.toolName, part.input);
        const input = openTools.get(part.toolCallId)?.input;
        openTools.delete(part.toolCallId);
        toolResults.push({ toolName: part.toolName, output: part.output });
        ctx.emit({
          type: "span-end",
          id: part.toolCallId,
          t: ctx.now(),
          status: "ok",
          detail: { input: smallDetail(input, 500), output: smallDetail(part.output) },
        });
        return;
      }
      case "tool-error": {
        if (!openTools.has(part.toolCallId)) startTool(part.toolCallId, part.toolName, part.input);
        openTools.delete(part.toolCallId);
        ctx.emit({ type: "span-end", id: part.toolCallId, t: ctx.now(), status: "error", detail: { error: errorMessage(part.error) } });
        return;
      }
      case "tool-output-denied": {
        if (!openTools.has(part.toolCallId)) return;
        openTools.delete(part.toolCallId);
        ctx.emit({ type: "span-end", id: part.toolCallId, t: ctx.now(), status: "error", detail: { error: "denied" } });
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
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(idleTimeoutError()), STREAM_IDLE_MS);
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
      armIdle();
      handle(r.value);
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
  if (openTools.size > 0) {
    const t = ctx.now();
    for (const id of openTools.keys()) ctx.emit({ type: "span-end", id, t, status: "error", detail: { error: "no tool result" } });
    openTools.clear();
  }
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

/**
 * Run a subagent as a child `invoke_agent` span of `parentSpanId` (normally the
 * calling tool's toolCallId). Text is not forwarded to the client.
 */
export async function runSubagent<I>(
  def: SubagentDef<I>,
  input: I,
  ctx: RunContext,
  parentSpanId: string,
  index: number,
): Promise<{ text: string }> {
  const id = `${parentSpanId}:${def.functionId}:${index}`;
  ctx.emit({ type: "span-start", id, parentId: parentSpanId, kind: "invoke_agent", name: def.functionId, t: ctx.now() });
  try {
    const model = AGENT_MODELS[def.model];
    const result = ctx.ai.streamText({
      model: createAgentModel(ctx.env, model, { functionId: def.functionId, conversationId: ctx.conversationId }),
      system: def.system,
      prompt: def.prompt(input),
      tools: def.tools(ctx),
      stopWhen: stepCountIs(def.maxSteps),
      maxOutputTokens: model.maxTokens,
      abortSignal: ctx.signal,
      experimental_telemetry: telemetry(def.functionId, ctx.conversationId),
    });
    const { text } = await pipeStepStream(result.fullStream, ctx, {
      parentSpanId: id,
      modelLabel: model.key,
      forwardText: false,
    });
    const detail = def.toDetail ? smallDetail(def.toDetail(text)) : { output: text.slice(0, DETAIL_MAX_CHARS) };
    ctx.emit({ type: "span-end", id, t: ctx.now(), status: "ok", detail });
    return { text };
  } catch (err) {
    recordActiveSpanException(err);
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

  // Per-run accounting: sum usage over every chat span (incl. subagents that use
  // this ctx) and record when the first visible delta reached the client.
  const chatSpans = new Set<string>();
  const usage = { input: 0, output: 0 };
  let firstVisibleAt: number | undefined;
  const emit = (e: TraceEvent) => {
    if (e.type === "span-start" && e.kind === "chat") chatSpans.add(e.id);
    else if (e.type === "span-end" && e.usage && chatSpans.has(e.id)) {
      usage.input += e.usage.input;
      usage.output += e.usage.output;
    } else if ((e.type === "text-delta" || e.type === "reasoning-delta") && firstVisibleAt === undefined) {
      firstVisibleAt = ctx.now();
    }
    try {
      ctx.emit(e);
    } catch {
      // a closed client stream must not turn into a run failure; ctx.signal handles disconnects
    }
  };
  const runCtx: RunContext = { ...ctx, emit };

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
      tools: def.tools(runCtx),
      stopWhen: stepCountIs(def.maxSteps),
      maxOutputTokens: model.maxTokens,
      abortSignal: ctx.signal,
      experimental_telemetry: telemetry(def.functionId, ctx.conversationId),
    });
    const { text, toolResults } = await pipeStepStream(result.fullStream, runCtx, {
      parentSpanId: runId,
      modelLabel: model.key,
      forwardText: true,
    });
    await def.after?.(runCtx, { text, rootSpanId: runId, toolResults });
    emit({ type: "span-end", id: runId, t: ctx.now(), status: "ok", detail: { output: text.slice(0, DETAIL_MAX_CHARS) } });
    finish("ok");
  } catch (err) {
    recordActiveSpanException(err);
    const aborted = ctx.signal.aborted || isAbortError(err);
    const message = aborted ? "aborted" : errorMessage(err);
    emit({ type: "span-end", id: runId, t: ctx.now(), status: "error", detail: { error: message } });
    if (aborted) finish("aborted");
    else finish("error", message);
  }
}
