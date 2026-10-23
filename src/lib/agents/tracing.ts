// Agent tracing glue (Cloudflare Agents observability).
//
// `agents/observability/ai` imports `cloudflare:workers` at module top level, and
// neither `next dev`, `next build` nor OpenNext's esbuild can resolve that scheme
// (spec §7 Q1). So: never import either statically. `getTracedAI()` loads
// `cloudflare:workers` at runtime via a non-literal specifier (only workerd can
// resolve it), stashes it on `globalThis.__CF_WORKERS__` — which next.config.mjs's
// webpack externals map `cloudflare:workers` to — and only then loads the wrapper.
// Anywhere that fails (node, next dev, tests) we fall back to the plain `ai` namespace.
import * as aiNamespace from "ai";

type AI = typeof import("ai");

interface ActiveSpan {
  setAttribute?(key: string, value: string | number | boolean): void;
  setAttributes?(attrs: Record<string, string | number | boolean>): void;
  recordException?(err: unknown): void;
}

interface TracingHandle {
  getActiveSpan?(): ActiveSpan | undefined | null;
  /** workerd: runs `callback` in a new active span and ends it when the callback (or its promise) settles. */
  enterSpan?(name: string, callback: (span: unknown) => unknown): unknown;
  /** workerd: like enterSpan, but the callback ends the span. */
  startActiveSpan?(name: string, callback: (span: unknown) => unknown): unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __CF_WORKERS__: { tracing?: TracingHandle } | undefined;
}

const tracedAICache = new Map<boolean, Promise<AI>>();
let tracingActive = false;
let warned = false;

/** Falling back to plain `ai` means no Cloudflare spans for this isolate: say so (once per isolate), not silently. */
function tracingDisabled(err: unknown): AI {
  tracingActive = false;
  if (!warned) {
    warned = true;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`agents tracing disabled: ${reason}`);
  }
  return aiNamespace;
}

async function loadTracedAI(storeContent: boolean): Promise<AI> {
  try {
    const spec = "cloudflare:workers";
    globalThis.__CF_WORKERS__ = await import(/* webpackIgnore: true */ /* @vite-ignore */ spec);
  } catch (err) {
    return tracingDisabled(err);
  }
  try {
    const { wrapAISDK } = await import("agents/observability/ai");
    const wrapped = wrapAISDK(aiNamespace as unknown as Record<string, unknown>, {
      storeMessages: storeContent,
      storeTools: storeContent,
    }) as unknown as AI;
    tracingActive = true;
    return wrapped;
  } catch (err) {
    return tracingDisabled(err);
  }
}

/** Whether getTracedAI() wrapped the AI SDK with Cloudflare Agents tracing (false in node / next dev / on failure). */
export function isTracingActive(): boolean {
  return tracingActive;
}

/** AI SDK namespace wrapped with Agents tracing when running in workerd; plain `ai` otherwise. */
export function getTracedAI(opts: { storeContent: boolean }): Promise<AI> {
  const key = opts.storeContent;
  let cached = tracedAICache.get(key);
  if (!cached) {
    cached = loadTracedAI(key);
    tracedAICache.set(key, cached);
  }
  return cached;
}

function activeSpan(): ActiveSpan | undefined {
  try {
    const tracing = globalThis.__CF_WORKERS__?.tracing;
    return tracing?.getActiveSpan?.() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Set attributes on the currently active Cloudflare span; no-op without a tracing runtime. */
export function setActiveSpanAttributes(attrs: Record<string, string | number | boolean>): void {
  const span = activeSpan();
  if (!span) return;
  try {
    if (typeof span.setAttribute === "function") {
      for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    } else {
      span.setAttributes?.(attrs);
    }
  } catch {
    // tracing must never break the request
  }
}

/** Record an exception on the currently active Cloudflare span; no-op without a tracing runtime. */
export function recordActiveSpanException(err: unknown): void {
  const span = activeSpan();
  if (!span) return;
  const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : String(err));
  try {
    if (typeof span.recordException === "function") {
      span.recordException(error);
    } else {
      span.setAttribute?.("error.type", error.name || "Error");
      span.setAttribute?.("exception.message", error.message.slice(0, 1000));
    }
  } catch {
    // tracing must never break the request
  }
}

// ---------------------------------------------------------------------------
// Custom spans for deterministic tools (prefetch, researcher searches): the AI SDK wrapper only traces tools the
// model calls, so these get an `execute_tool` span of their own with the same gen_ai attributes.

const TOOL_ATTR_MAX_CHARS = 8000;

function jsonAttr(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    s = "[unserializable]";
  }
  return s.length > TOOL_ATTR_MAX_CHARS ? `${s.slice(0, TOOL_ATTR_MAX_CHARS)}…` : s;
}

function setSpanAttrs(span: ActiveSpan | undefined, attrs: Record<string, string | number | boolean>): void {
  if (!span) return;
  try {
    if (typeof span.setAttribute === "function") for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    else span.setAttributes?.(attrs);
  } catch {
    // tracing must never break the request
  }
}

const isSpanLike = (v: unknown): v is ActiveSpan =>
  typeof v === "object" && v !== null && typeof (v as ActiveSpan).setAttribute === "function";

type SpanCallback<T> = (span: unknown) => Promise<T>;

/**
 * Run `fn` inside a Cloudflare custom span `execute_tool {name}` (tracing.enterSpan; startActiveSpan as a fallback)
 * with `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id` and — when `storeContent`
 * — `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` (JSON, ≤ 8 KB). The span is active while `fn` runs,
 * so setActiveSpanAttributes() inside it (e.g. `cache.hit`) lands on it. Without a tracing runtime: just `fn()`.
 */
export async function withToolSpan<T>(
  info: { name: string; callId: string; input: unknown; storeContent: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  let tracing: TracingHandle | undefined;
  try {
    tracing = globalThis.__CF_WORKERS__?.tracing;
  } catch {
    tracing = undefined;
  }
  const enter = typeof tracing?.enterSpan === "function" ? tracing.enterSpan : undefined;
  const start = typeof tracing?.startActiveSpan === "function" ? tracing.startActiveSpan : undefined;
  if (!tracing || (!enter && !start)) return fn();

  let started = false;
  const body = async (arg: unknown, endWhenDone: boolean): Promise<T> => {
    started = true;
    const span = isSpanLike(arg) ? arg : activeSpan();
    setSpanAttrs(span, {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": info.name,
      "gen_ai.tool.call.id": info.callId,
      ...(info.storeContent ? { "gen_ai.tool.call.arguments": jsonAttr(info.input) } : {}),
    });
    try {
      const result = await fn();
      if (info.storeContent) setSpanAttrs(span, { "gen_ai.tool.call.result": jsonAttr(result) });
      return result;
    } catch (err) {
      setSpanAttrs(span, { "error.type": err instanceof Error ? err.name || "Error" : typeof err });
      throw err;
    } finally {
      if (endWhenDone) {
        try {
          (span as { end?: () => void } | undefined)?.end?.();
        } catch {
          // ignore
        }
      }
    }
  };
  const name = `execute_tool ${info.name}`;
  try {
    // enterSpan ends the span itself when the callback's promise settles; startActiveSpan leaves that to us.
    if (enter) return await (enter as (n: string, cb: SpanCallback<T>) => Promise<T>).call(tracing, name, (s) => body(s, false));
    return await (start as (n: string, cb: SpanCallback<T>) => Promise<T>).call(tracing, name, (s) => body(s, true));
  } catch (err) {
    // A tracing API that throws before running the callback must not lose the tool call.
    if (!started) return fn();
    throw err;
  }
}
