import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AgentEnv } from "./env";
import type { AgentModel } from "./models";
import { setActiveSpanAttributes } from "./tracing";

/**
 * Merge extra top-level fields into a JSON request body.
 * Workers AI GLM/Kimi reasoning is controlled by the body field `reasoning_effort`,
 * which AI SDK providerOptions do not reliably forward. Non-JSON or missing bodies
 * are returned untouched.
 */
export function injectBodyParams(
  init: RequestInit | undefined,
  params: Record<string, unknown>,
): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  try {
    const parsed = JSON.parse(init.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return init;
    return { ...init, body: JSON.stringify({ ...parsed, ...params }) };
  } catch {
    return init;
  }
}

// ---------------------------------------------------------------------------
// Hedged requests
//
// Workers AI's first-token latency has a random long tail (10–19 s in about 1 run of 3, otherwise 1–5 s). A
// streaming chat completion is therefore sent once (A); if A has not delivered its first body chunk after
// HEDGE_AFTER_MS, an identical request (B) goes out and whichever delivers a first chunk first wins — the other
// is aborted. Done at the fetch level, so it is transparent to the AI SDK and to wrapAISDK's tracing.

export const HEDGE_AFTER_MS = 2500;
/** Per-isolate cap on hedge (B) requests in flight, so hedging cannot exhaust the isolate's connection budget. */
export const MAX_INFLIGHT_HEDGES = 2;
let inflightHedges = 0;
/** Number of hedge (B) requests currently in flight in this isolate (for tests / diagnostics). */
export function getInflightHedges(): number {
  return inflightHedges;
}

/** `AGENTS_HEDGE_AFTER_MS`: unset / empty / invalid -> default; `0` -> hedging off. */
export function parseHedgeAfterMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return HEDGE_AFTER_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : HEDGE_AFTER_MS;
}
export const HEDGE_HEADER = "x-agents-hedge";
export const HEDGE_FIRED_HEADER = "x-agents-hedge-fired";

export interface HedgeOutcome {
  winner: "a" | "b";
  fired: boolean;
  /** Time from sending A to the winner's first body chunk. */
  firstChunkMs: number;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Only streaming chat completions are hedged. */
export function isStreamingChatRequest(url: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  if (!/\/chat\/completions(\?|$)/.test(href)) return false;
  if (!init || typeof init.body !== "string") return false;
  try {
    return (JSON.parse(init.body) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

function abortReason(signal: AbortSignal): unknown {
  const r = signal.reason;
  if (r instanceof Error || (typeof r === "object" && r !== null && (r as { name?: unknown }).name === "AbortError")) return r;
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function dropBody(res: Response | undefined) {
  void res?.body?.cancel().catch(() => {});
}

/**
 * fetch with one hedge (see above). Rules:
 * - A first; B after `hedgeAfterMs` without A's first body chunk, or at once if A fails before that;
 *   B is only started while fewer than MAX_INFLIGHT_HEDGES hedges are in flight in this isolate;
 * - the first attempt to deliver a body chunk wins, the other is aborted; the returned Response replays the
 *   winner's first chunk followed by the rest of its stream, with `x-agents-hedge: a|b` and
 *   `x-agents-hedge-fired: 0|1` added;
 * - a 5xx, a network error and (while the other attempt is still in flight) a 4xx are failures that are stored
 *   while the other attempt keeps going; a 429/408/409 or 5xx also starts B at once. A 4xx with nothing else
 *   pending is returned immediately; when all attempts fail, the last failure is surfaced (a Response as such);
 * - failed responses that are superseded or lose are cancelled, never leaked;
 * - the caller's AbortSignal aborts both attempts (and, after a win, the winner's stream).
 */
export function hedgedFetch(
  doFetch: Fetch,
  url: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: { hedgeAfterMs?: number; now?: () => number; onOutcome?: (o: HedgeOutcome) => void } = {},
): Promise<Response> {
  const hedgeAfterMs = opts.hedgeAfterMs ?? HEDGE_AFTER_MS;
  const now = opts.now ?? (() => Date.now());
  const callerSignal = init?.signal ?? undefined;
  if (callerSignal?.aborted) return Promise.reject(abortReason(callerSignal));
  const t0 = now();

  return new Promise<Response>((resolve, reject) => {
    type Attempt = { name: "a" | "b"; ac: AbortController; done: boolean; released: boolean };
    const attempts: Attempt[] = [];
    let settled = false;
    let bStarted = false;
    let lastFailure: { response?: Response; error?: unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** Give back B's slot in the isolate-wide limiter (idempotent, so no path can leak or double-release it). */
    const release = (a: Attempt) => {
      if (a.name === "b" && !a.released) {
        a.released = true;
        inflightHedges = Math.max(0, inflightHedges - 1);
      }
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const abortOthers = (keep?: Attempt) => {
      for (const a of attempts) {
        if (a === keep) continue;
        a.ac.abort();
        release(a);
      }
    };
    const onCallerAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      abortOthers();
      dropBody(lastFailure?.response);
      reject(abortReason(callerSignal!));
    };

    const win = (attempt: Attempt, res: Response, first: Uint8Array | undefined, reader?: ReadableStreamDefaultReader<Uint8Array>) => {
      settled = true;
      cleanup();
      abortOthers(attempt);
      dropBody(lastFailure?.response);
      const fired = bStarted;
      try {
        opts.onOutcome?.({ winner: attempt.name, fired, firstChunkMs: now() - t0 });
      } catch {
        // reporting must never break the request
      }
      const headers = new Headers(res.headers);
      headers.set(HEDGE_HEADER, attempt.name);
      headers.set(HEDGE_FIRED_HEADER, fired ? "1" : "0");
      let body: ReadableStream<Uint8Array> | null = null;
      if (reader) {
        let pendingFirst = first;
        body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (pendingFirst) {
              controller.enqueue(pendingFirst);
              pendingFirst = undefined;
              return;
            }
            try {
              const { done, value } = await reader.read();
              if (done) controller.close();
              else controller.enqueue(value);
            } catch (err) {
              controller.error(err);
            }
          },
          cancel(reason) {
            void reader.cancel(reason).catch(() => {});
            attempt.ac.abort();
          },
        });
      }
      resolve(new Response(body, { status: res.status, statusText: res.statusText, headers }));
    };

    /** Start B if it has not started and the isolate-wide hedge limit allows it. */
    const tryStartB = (): boolean => {
      if (settled || bStarted || inflightHedges >= MAX_INFLIGHT_HEDGES) return false;
      inflightHedges++;
      bStarted = true;
      start("b");
      return true;
    };

    /** `retryable`: the failure is worth an immediate B (5xx, network error, 429/408/409). */
    const fail = (attempt: Attempt, failure: { response?: Response; error?: unknown }, retryable: boolean) => {
      attempt.done = true;
      if (settled) {
        dropBody(failure.response);
        return;
      }
      dropBody(lastFailure?.response);
      lastFailure = failure;
      if (retryable && !bStarted && tryStartB()) return; // B now pending
      if (attempts.some((a) => !a.done)) return; // the other attempt is still in flight: keep waiting for it
      settled = true;
      cleanup();
      if (failure.response) resolve(failure.response);
      else reject(failure.error);
    };

    const start = (name: "a" | "b") => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const ac = new AbortController();
      const attempt: Attempt = { name, ac, done: false, released: false };
      attempts.push(attempt);
      const signal = callerSignal ? AbortSignal.any([callerSignal, ac.signal]) : ac.signal;
      void (async () => {
        try {
          let res: Response;
          try {
            res = await doFetch(url, { ...init, signal });
          } catch (error) {
            if (!settled && !ac.signal.aborted) fail(attempt, { error }, true);
            return;
          }
          if (settled) {
            dropBody(res);
            return;
          }
          if (res.status >= 400 && res.status < 500) {
            // The request itself is bad (auth, validation): a hedge would fail the same way, so only a
            // rate-limit / timeout / conflict starts B. While the other attempt is in flight this is just a
            // stored failure; with nothing else pending it is returned.
            fail(attempt, { response: res }, res.status === 429 || res.status === 408 || res.status === 409);
            return;
          }
          if (!res.ok) {
            fail(attempt, { response: res }, true);
            return;
          }
          if (!res.body) {
            win(attempt, res, undefined);
            return;
          }
          const reader = res.body.getReader();
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
            // skip empty chunks: only real bytes count as the first chunk
            while (!chunk.done && chunk.value.byteLength === 0) chunk = await reader.read();
          } catch (error) {
            if (!settled && !ac.signal.aborted) fail(attempt, { error }, true);
            return;
          }
          if (settled) {
            void reader.cancel().catch(() => {});
            return;
          }
          win(attempt, res, chunk.done ? undefined : chunk.value, reader);
        } finally {
          release(attempt);
        }
      })();
    };

    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    start("a");
    if (!settled && !bStarted && hedgeAfterMs > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        tryStartB();
      }, hedgeAfterMs);
    }
  });
}

export function createAgentModel(
  env: AgentEnv,
  model: AgentModel,
  meta: { functionId: string; conversationId: string },
): LanguageModel {
  // \uXXXX-escape non-ASCII so the header stays Latin-1 safe (AI Gateway decodes it).
  const metadata = JSON.stringify({ agent: meta.functionId, conversation: meta.conversationId }).replace(
    /[^\x20-\x7E]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  const openai = createOpenAI({
    apiKey: env.CF_API_TOKEN,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/compat`,
    // cf-aig-* headers live in init.headers, so both hedged attempts carry them
    headers: {
      ...(env.CF_AIG_TOKEN ? { "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}` } : {}),
      "cf-aig-skip-cache": "true",
      "cf-aig-metadata": metadata,
    },
    fetch: agentFetch(model, meta.functionId, parseHedgeAfterMs(env.AGENTS_HEDGE_AFTER_MS)),
  });

  return openai.chat(`workers-ai/${model.workersAiId}`);
}

/**
 * The provider's fetch: adds `reasoning_effort` to the body, then hedges streaming chat completions. The SDK puts
 * the provider headers (cf-aig-*) into `init.headers`, and both hedged attempts are sent with this same init.
 */
export function agentFetch(model: AgentModel, functionId: string, hedgeAfterMs: number = HEDGE_AFTER_MS): Fetch {
  return (url, init) => {
    const withBody = injectBodyParams(init, { reasoning_effort: model.reasoningEffort });
    // hedgeAfterMs 0 = hedging off (AGENTS_HEDGE_AFTER_MS=0)
    if (hedgeAfterMs <= 0 || !isStreamingChatRequest(url, withBody)) return fetch(url, withBody);
    return hedgedFetch((u, i) => fetch(u, i), url, withBody, {
      hedgeAfterMs,
      onOutcome: ({ winner, fired, firstChunkMs }) => {
        setActiveSpanAttributes({ "hedge.fired": fired, "hedge.winner": winner });
        if (fired) {
          console.log(`[agents] hedge fired (${functionId}, ${model.key}): winner=${winner}, first chunk after ${firstChunkMs} ms`);
        }
      },
    });
  };
}
