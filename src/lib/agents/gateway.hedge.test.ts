import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODELS } from "./models";
import { HEDGE_AFTER_MS, agentFetch, hedgedFetch, isStreamingChatRequest, type HedgeOutcome } from "./gateway";

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
