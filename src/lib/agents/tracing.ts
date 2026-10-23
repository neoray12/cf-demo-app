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
