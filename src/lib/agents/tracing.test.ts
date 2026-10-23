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
