import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODELS } from "./models";
import {
  HEDGE_AFTER_MS,
  MAX_INFLIGHT_HEDGES,
  agentFetch,
  getInflightHedges,
  hedgedFetch,
  isStreamingChatRequest,
  parseHedgeAfterMs,
  type HedgeOutcome,
} from "./gateway";

const enc = (s: string) => new TextEncoder().encode(s);

/** A Response whose body chunks the test pushes by hand. */
function controlled(status = 200) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  const res = new Response(body, { status, headers: { "content-type": "text/event-stream", "x-up": "1" } });
  return {
    res,
    push: (s: string) => ctl.enqueue(enc(s)),
    close: () => ctl.close(),
  };
}

type Attempt = { signal: AbortSignal; init: RequestInit; resolve(r: Response): void; reject(e: unknown): void };

/** fetch double: every call is recorded and stays pending until the test resolves/rejects it. */
function fakeFetch() {
  const attempts: Attempt[] = [];
  const fn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      attempts.push({ signal, init: init!, resolve, reject });
    });
  });
  return { fn, attempts };
}

const URL_ = "https://gateway.ai.cloudflare.com/v1/a/g/compat/chat/completions";
const BODY = JSON.stringify({ model: "m", stream: true });

async function text(res: Response) {
  return await res.text();
}

describe("hedgedFetch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("A delivers its first chunk in time → no hedge, one request, A's stream (first chunk included)", async () => {
    const f = fakeFetch();
    const outcomes: HedgeOutcome[] = [];
    let t = 0;
    const p = hedgedFetch(f.fn, URL_, { method: "POST", body: BODY }, { now: () => t, onOutcome: (o) => outcomes.push(o) });
    const a = controlled();
    f.attempts[0]!.resolve(a.res);
    await vi.advanceTimersByTimeAsync(100);
    t = 900;
    a.push("data: 1\n\n");
    const res = await p;
    a.push("data: 2\n\n");
    a.close();
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 2);
    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(res.headers.get("x-agents-hedge")).toBe("a");
    expect(res.headers.get("x-agents-hedge-fired")).toBe("0");
    expect(res.headers.get("x-up")).toBe("1");
    expect(await text(res)).toBe("data: 1\n\ndata: 2\n\n");
    expect(outcomes).toEqual([{ winner: "a", fired: false, firstChunkMs: 900 }]);
  });

  it("A slow → B sent after HEDGE_AFTER_MS with the same init; B's first chunk wins and A is aborted", async () => {
    const f = fakeFetch();
    const outcomes: HedgeOutcome[] = [];
    const init = { method: "POST", body: BODY, headers: { "cf-aig-metadata": "{}" } };
    const p = hedgedFetch(f.fn, URL_, init, { onOutcome: (o) => outcomes.push(o) });
    const a = controlled();
    f.attempts[0]!.resolve(a.res); // headers arrive, but no body chunk
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS - 1);
    expect(f.fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fn).toHaveBeenCalledTimes(2);
    expect(f.attempts[1]!.init.body).toBe(BODY);
    expect(f.attempts[1]!.init.headers).toEqual(init.headers);
    const b = controlled();
    f.attempts[1]!.resolve(b.res);
    b.push("data: B\n\n");
    b.close();
    const res = await p;
    expect(res.headers.get("x-agents-hedge")).toBe("b");
    expect(res.headers.get("x-agents-hedge-fired")).toBe("1");
    expect(await text(res)).toBe("data: B\n\n");
    expect(f.attempts[0]!.signal.aborted).toBe(true);
    expect(f.attempts[1]!.signal.aborted).toBe(false);
    expect(outcomes.map((o) => [o.winner, o.fired])).toEqual([["b", true]]);
  });

  it("A slow but delivers first after B started → A wins and B is aborted", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    const a = controlled();
    f.attempts[0]!.resolve(a.res);
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    a.push("x");
    a.close();
    const res = await p;
    expect(res.headers.get("x-agents-hedge")).toBe("a");
    expect(res.headers.get("x-agents-hedge-fired")).toBe("1");
    expect(f.attempts[1]!.signal.aborted).toBe(true);
    expect(await text(res)).toBe("x");
  });

  it("A errors before the hedge timer → B starts immediately", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    f.attempts[0]!.reject(new TypeError("network down"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fn).toHaveBeenCalledTimes(2);
    const b = controlled();
    f.attempts[1]!.resolve(b.res);
    b.push("ok");
    b.close();
    const res = await p;
    expect(res.headers.get("x-agents-hedge")).toBe("b");
    expect(await text(res)).toBe("ok");
  });

  it("a 5xx counts as a failure (→ B); both failing surfaces the last failure", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    f.attempts[0]!.resolve(new Response("upstream", { status: 503 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fn).toHaveBeenCalledTimes(2);
    f.attempts[1]!.reject(new TypeError("network down again"));
    await expect(p).rejects.toThrow("network down again");

    const g = fakeFetch();
    const q = hedgedFetch(g.fn, URL_, { body: BODY });
    g.attempts[0]!.reject(new TypeError("first"));
    await vi.advanceTimersByTimeAsync(0);
    g.attempts[1]!.resolve(new Response("bad gateway", { status: 502 }));
    const res = await q;
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("bad gateway");
  });

  it("both requests erroring → rejects with the last error", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    f.attempts[0]!.reject(new Error("A failed"));
    await vi.advanceTimersByTimeAsync(10);
    f.attempts[1]!.reject(new Error("B failed"));
    await expect(p).rejects.toThrow("B failed");
  });

  it("a 4xx is returned at once and never hedged", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    f.attempts[0]!.resolve(new Response('{"error":"bad auth"}', { status: 401 }));
    const res = await p;
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 2);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"bad auth"}');
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it("the caller's abort cancels both attempts and rejects with an AbortError", async () => {
    const f = fakeFetch();
    const caller = new AbortController();
    const p = hedgedFetch(f.fn, URL_, { body: BODY, signal: caller.signal });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect(f.fn).toHaveBeenCalledTimes(2);
    caller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(f.attempts.every((a) => a.signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 2);
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it("an already-aborted caller signal sends nothing", async () => {
    const f = fakeFetch();
    const caller = new AbortController();
    caller.abort();
    await expect(hedgedFetch(f.fn, URL_, { body: BODY, signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.fn).not.toHaveBeenCalled();
  });

  it("after a win, the caller's abort still stops the winner's stream", async () => {
    const f = fakeFetch();
    const caller = new AbortController();
    const p = hedgedFetch(f.fn, URL_, { body: BODY, signal: caller.signal });
    const a = controlled();
    f.attempts[0]!.resolve(a.res);
    a.push("1");
    const res = await p;
    expect(f.attempts[0]!.signal.aborted).toBe(false);
    caller.abort();
    expect(f.attempts[0]!.signal.aborted).toBe(true);
    void res.body?.cancel();
  });
});

describe("isStreamingChatRequest / agentFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("only streaming chat completions are hedged", () => {
    expect(isStreamingChatRequest(URL_, { body: BODY })).toBe(true);
    expect(isStreamingChatRequest(URL_, { body: JSON.stringify({ stream: false }) })).toBe(false);
    expect(isStreamingChatRequest("https://x/compat/embeddings", { body: BODY })).toBe(false);
    expect(isStreamingChatRequest(new URL(URL_), undefined)).toBe(false);
  });

  it("both hedged attempts carry the cf-aig headers and the reasoning_effort body", async () => {
    vi.useFakeTimers();
    const f = fakeFetch();
    vi.stubGlobal("fetch", f.fn);
    const doFetch = agentFetch(AGENT_MODELS["kimi-k2.6"], "docs-agent");
    const headers = { "cf-aig-authorization": "Bearer x", "cf-aig-skip-cache": "true", "cf-aig-metadata": "{}" };
    const p = doFetch(URL_, { method: "POST", headers, body: BODY });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect(f.fn).toHaveBeenCalledTimes(2);
    for (const a of f.attempts) {
      expect(a.init.headers).toEqual(headers);
      expect(JSON.parse(a.init.body as string)).toEqual({ model: "m", stream: true, reasoning_effort: "none" });
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const b = controlled();
    f.attempts[1]!.resolve(b.res);
    b.push("x");
    b.close();
    expect((await p).headers.get("x-agents-hedge")).toBe("b");
    expect(String(log.mock.calls[0]?.[0])).toMatch(/hedge fired \(docs-agent, kimi-k2.6\): winner=b/);
  });

  it("non-streaming requests go straight to fetch (body still gets reasoning_effort)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await agentFetch(AGENT_MODELS["glm-5.3-flash"], "x")(URL_, { body: JSON.stringify({ stream: false }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      stream: false,
      reasoning_effort: "low",
    });
  });
});

/** A failure Response whose body cancellation is observable. */
function spied(status: number) {
  const cancel = vi.fn();
  const res = new Response(
    new ReadableStream<Uint8Array>({
      pull() {},
      cancel,
    }),
    { status },
  );
  return { res, cancel };
}

describe("hedgedFetch: 4xx handling, body cleanup, hedge limiter, off-switch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("B gets a 429 while A is slow but healthy → A wins (200), the 429 body is cancelled", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    const a = controlled();
    f.attempts[0]!.resolve(a.res);
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect(f.fn).toHaveBeenCalledTimes(2);
    const b = spied(429);
    f.attempts[1]!.resolve(b.res);
    await vi.advanceTimersByTimeAsync(10);
    a.push("data: A\n\n");
    a.close();
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get("x-agents-hedge")).toBe("a");
    expect(b.cancel).toHaveBeenCalled();
    expect(await text(res)).toBe("data: A\n\n");
  });

  it("A gets a 429 → B starts at once; B wins and the 429 body is cancelled", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    const a = spied(429);
    f.attempts[0]!.resolve(a.res);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fn).toHaveBeenCalledTimes(2);
    const b = controlled();
    f.attempts[1]!.resolve(b.res);
    b.push("ok");
    b.close();
    const res = await p;
    expect(res.headers.get("x-agents-hedge")).toBe("b");
    expect(a.cancel).toHaveBeenCalled();
  });

  it("a plain 4xx (401) with B in flight is stored; the request waits for B", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect(f.fn).toHaveBeenCalledTimes(2);
    f.attempts[0]!.resolve(new Response("bad auth", { status: 401 }));
    await vi.advanceTimersByTimeAsync(10);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false); // B still pending
    f.attempts[1]!.resolve(new Response("boom", { status: 500 }));
    const res = await p;
    expect(res.status).toBe(500); // last failure wins when everything failed
    expect(await res.text()).toBe("boom");
  });

  it("a plain 4xx (401) with nothing else pending is returned at once", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    f.attempts[0]!.resolve(new Response("bad auth", { status: 401 }));
    expect((await p).status).toBe(401);
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it("a replaced stored failure is cancelled", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    const a = spied(502);
    f.attempts[0]!.resolve(a.res);
    await vi.advanceTimersByTimeAsync(0);
    const b = spied(503);
    f.attempts[1]!.resolve(b.res);
    const res = await p;
    expect(res.status).toBe(503);
    expect(a.cancel).toHaveBeenCalled();
    expect(b.cancel).not.toHaveBeenCalled(); // the surfaced response is the caller's to read
  });

  it("a stored failure is cancelled when the caller aborts", async () => {
    const f = fakeFetch();
    const caller = new AbortController();
    const p = hedgedFetch(f.fn, URL_, { body: BODY, signal: caller.signal });
    p.catch(() => {});
    const a = spied(502);
    f.attempts[0]!.resolve(a.res);
    await vi.advanceTimersByTimeAsync(0); // B started, A's 502 stored
    caller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(a.cancel).toHaveBeenCalled();
  });

  it("A 5xx then B wins: A's 5xx body is cancelled", async () => {
    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    const a = spied(502);
    f.attempts[0]!.resolve(a.res);
    await vi.advanceTimersByTimeAsync(0);
    const b = controlled();
    f.attempts[1]!.resolve(b.res);
    b.push("x");
    await p;
    expect(a.cancel).toHaveBeenCalled();
  });

  it(`at most ${MAX_INFLIGHT_HEDGES} hedges in flight per isolate: a third slow call does not hedge; slots are released`, async () => {
    const fs = [fakeFetch(), fakeFetch(), fakeFetch()];
    const callers = fs.map(() => new AbortController());
    const ps = fs.map((f, i) => {
      const p = hedgedFetch(f.fn, URL_, { body: BODY, signal: callers[i]!.signal });
      p.catch(() => {});
      return p;
    });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect(fs.map((f) => f.fn.mock.calls.length)).toEqual([2, 2, 1]);
    expect(getInflightHedges()).toBe(MAX_INFLIGHT_HEDGES);
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 4);
    expect(fs[2]!.fn).toHaveBeenCalledTimes(1);

    // call 1's B fails with a network error → its slot is free again
    fs[0]!.attempts[1]!.reject(new TypeError("net"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getInflightHedges()).toBe(1);

    // every other path (caller abort) releases too
    callers.forEach((c) => c.abort());
    await Promise.allSettled(ps);
    expect(getInflightHedges()).toBe(0);
  });

  it("a hedge slot is released when A wins, and when B wins", async () => {
    const f1 = fakeFetch();
    const p1 = hedgedFetch(f1.fn, URL_, { body: BODY });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect(getInflightHedges()).toBe(1);
    const a = controlled();
    f1.attempts[0]!.resolve(a.res);
    a.push("a");
    await p1;
    expect(getInflightHedges()).toBe(0);

    const f2 = fakeFetch();
    const p2 = hedgedFetch(f2.fn, URL_, { body: BODY });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    const b = controlled();
    f2.attempts[1]!.resolve(b.res);
    b.push("b");
    await p2;
    expect(getInflightHedges()).toBe(0);
  });

  it("A failing while the hedge limit is reached surfaces A's failure instead of hanging", async () => {
    const hold = [fakeFetch(), fakeFetch()];
    const callers = hold.map(() => new AbortController());
    const held = hold.map((f, i) => {
      const p = hedgedFetch(f.fn, URL_, { body: BODY, signal: callers[i]!.signal });
      p.catch(() => {});
      return p;
    });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect(getInflightHedges()).toBe(MAX_INFLIGHT_HEDGES);

    const f = fakeFetch();
    const p = hedgedFetch(f.fn, URL_, { body: BODY });
    f.attempts[0]!.resolve(new Response("down", { status: 503 }));
    const res = await p;
    expect(res.status).toBe(503);
    expect(f.fn).toHaveBeenCalledTimes(1);

    callers.forEach((c) => c.abort());
    await Promise.allSettled(held);
    expect(getInflightHedges()).toBe(0);
  });
});

describe("AGENTS_HEDGE_AFTER_MS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("parseHedgeAfterMs: default when unset/invalid, 0 allowed", () => {
    expect(parseHedgeAfterMs(undefined)).toBe(HEDGE_AFTER_MS);
    expect(parseHedgeAfterMs("")).toBe(HEDGE_AFTER_MS);
    expect(parseHedgeAfterMs("abc")).toBe(HEDGE_AFTER_MS);
    expect(parseHedgeAfterMs("-5")).toBe(HEDGE_AFTER_MS);
    expect(parseHedgeAfterMs("0")).toBe(0);
    expect(parseHedgeAfterMs("1200")).toBe(1200);
  });

  it("0 disables hedging: one plain fetch with the injected params, even when slow", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    void agentFetch(AGENT_MODELS["kimi-k2.6"], "x", parseHedgeAfterMs("0"))(URL_, { method: "POST", body: BODY });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ model: "m", stream: true, reasoning_effort: "none" });
  });

  it("a custom delay is honoured", async () => {
    vi.useFakeTimers();
    const f = fakeFetch();
    vi.stubGlobal("fetch", f.fn);
    const p = agentFetch(AGENT_MODELS["kimi-k2.6"], "x", 300)(URL_, { method: "POST", body: BODY });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(299);
    expect(f.fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fn).toHaveBeenCalledTimes(2);
    f.attempts.forEach((a) => a.reject(new Error("done")));
  });
});
