import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("tracing fallback visibility", () => {
  it("warns once per isolate when tracing can't load, and reports isTracingActive() = false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracing = await import("./tracing");
    expect(tracing.isTracingActive()).toBe(false);

    // Two separate loads (one per storeContent flag) both fall back in node: only one warning.
    await tracing.getTracedAI({ storeContent: true });
    await tracing.getTracedAI({ storeContent: false });
    await tracing.getTracedAI({ storeContent: true });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^agents tracing disabled: .+/);
    expect(tracing.isTracingActive()).toBe(false);
  });
});

describe("withToolSpan", () => {
  afterEach(() => {
    delete (globalThis as { __CF_WORKERS__?: unknown }).__CF_WORKERS__;
  });

  it("attributes the custom span to the running agent and conversation", async () => {
    const attrs: Record<string, unknown> = {};
    const span = { setAttribute: (k: string, v: unknown) => void (attrs[k] = v) };
    (globalThis as { __CF_WORKERS__?: unknown }).__CF_WORKERS__ = {
      tracing: {
        enterSpan: (_name: string, cb: (s: unknown) => unknown) => cb(span),
        getActiveSpan: () => span,
      },
    };
    const { withToolSpan } = await import("./tracing");

    const out = await withToolSpan(
      {
        name: "search_docs",
        callId: "root/search_docs-1",
        input: { query: "q" },
        storeContent: false,
        agent: { name: "docs-researcher", id: "docs-researcher-demo" },
        conversationId: "conv-1",
      },
      async () => "ok",
    );

    expect(out).toBe("ok");
    expect(attrs).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search_docs",
      "gen_ai.agent.name": "docs-researcher",
      "gen_ai.agent.id": "docs-researcher-demo",
      "gen_ai.conversation.id": "conv-1",
    });
  });
});
