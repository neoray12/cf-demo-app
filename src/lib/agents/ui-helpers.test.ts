import { describe, expect, it } from "vitest";
import { reduceTrace, type RunTrace } from "./trace-tree";
import type { TraceEvent } from "./trace-events";
import {
  chartHasPrevious,
  chartRows,
  docDisplayName,
  formatBytes,
  formatChartValue,
  groundingOf,
  groupSources,
  indexState,
  kbFailureKey,
  readKbResponse,
  isHttpUrl,
  kbErrorKey,
  shouldKeepPolling,
  statusPollDelay,
  summarizeIndex,
  truncateLabel,
  visibleOutputs,
} from "./ui-helpers";

describe("indexState", () => {
  it("maps queued/running -> indexing, completed -> done, error -> failed", () => {
    expect(indexState({ status: "queued" })).toBe("indexing");
    expect(indexState({ status: "running" })).toBe("indexing");
    expect(indexState({ status: "completed" })).toBe("done");
    expect(indexState({ status: "error" })).toBe("failed");
  });
  it("a document absent from the status list is unknown, not failed", () => {
    expect(indexState(undefined)).toBe("unknown");
    expect(indexState({ status: "skipped" })).toBe("unknown");
    expect(indexState({ status: "unknown" })).toBe("unknown");
  });
});

describe("KB status polling", () => {
  it("statusPollDelay backs off 10 s → 20 s → 40 s and caps at 60 s", () => {
    expect([0, 1, 2, 3, 4, 50].map(statusPollDelay)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(statusPollDelay(-1)).toBe(10_000);
  });

  it("shouldKeepPolling: never for the sample or an empty workspace; until settled otherwise; failed rounds keep going", () => {
    const files = [{ key: "ws/a.md", status: "completed" }];
    expect(shouldKeepPolling({ writable: false, docKeys: ["default/a.md"], files: null })).toBe(false);
    expect(shouldKeepPolling({ writable: true, docKeys: [], files: [] })).toBe(false);
    expect(shouldKeepPolling({ writable: true, docKeys: ["ws/a.md"], files })).toBe(false);
    expect(shouldKeepPolling({ writable: true, docKeys: ["ws/a.md", "ws/b.md"], files })).toBe(true);
    expect(shouldKeepPolling({ writable: true, docKeys: ["ws/a.md"], files: [{ key: "ws/a.md", status: "running" }] })).toBe(true);
    expect(shouldKeepPolling({ writable: true, docKeys: null, files })).toBe(true);
    expect(shouldKeepPolling({ writable: true, docKeys: ["ws/a.md"], files: null })).toBe(true);
  });
});

describe("summarizeIndex", () => {
  const files = [
    { key: "ws/a.md", status: "completed" },
    { key: "ws/b.md", status: "running" },
    { key: "ws/c.md", status: "error", error: "boom" },
  ];
  it("counts each state; a doc missing from files is unknown", () => {
    const s = summarizeIndex(["ws/a.md", "ws/b.md", "ws/c.md", "ws/d.md"], files);
    expect(s).toMatchObject({ done: 1, indexing: 1, failed: 1, unknown: 1, settled: false });
  });
  it("settled only when every doc is completed or error", () => {
    expect(summarizeIndex(["ws/a.md", "ws/c.md"], files).settled).toBe(true);
    expect(summarizeIndex(["ws/a.md", "ws/b.md"], files).settled).toBe(false);
    // a freshly uploaded doc is not listed yet: keep polling
    expect(summarizeIndex(["ws/a.md", "ws/new.md"], files).settled).toBe(false);
  });
  it("no documents -> nothing to wait for but also not 'settled'", () => {
    expect(summarizeIndex([], files)).toMatchObject({ done: 0, indexing: 0, unknown: 0, settled: false });
  });
});

describe("small helpers", () => {
  it("docDisplayName strips the workspace prefix", () => {
    expect(docDisplayName("ws-abcd1234", "ws-abcd1234/site/example-com/index.md")).toBe("site/example-com/index.md");
    expect(docDisplayName("ws-abcd1234", "other/x.md")).toBe("other/x.md");
  });
  it("kbErrorKey passes known keys and falls back to server", () => {
    expect(kbErrorKey({ error: "agents.kb.errors.tooLarge" })).toBe("agents.kb.errors.tooLarge");
    expect(kbErrorKey({ error: "boom" })).toBe("agents.kb.errors.server");
    expect(kbErrorKey({ error: "agents.kb.errors.x y" })).toBe("agents.kb.errors.server");
    expect(kbErrorKey(null)).toBe("agents.kb.errors.server");
  });
  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
  it("isHttpUrl accepts only http(s)", () => {
    expect(isHttpUrl("https://radar.cloudflare.com/x")).toBe(true);
    expect(isHttpUrl("HTTP://a.b")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
  it("truncateLabel counts code points", () => {
    expect(truncateLabel("短標籤", 5)).toBe("短標籤");
    expect(truncateLabel("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("chart shaping", () => {
  const chart = (data: Array<{ label: string; value: number; previous?: number }>) => ({ data });
  it("keeps previous only where it exists (absent is not 0) and drops non-finite values", () => {
    const rows = chartRows(
      chart([
        { label: "美國", value: 22.6, previous: 23 },
        { label: "中國", value: 5.8 },
        { label: "bad", value: Number.NaN },
        { label: "bad2", value: 1, previous: Number.POSITIVE_INFINITY },
      ]),
    );
    expect(rows).toEqual([
      { label: "美國", value: 22.6, previous: 23 },
      { label: "中國", value: 5.8 },
      { label: "bad2", value: 1 },
    ]);
    expect(chartHasPrevious(rows)).toBe(true);
    expect(chartHasPrevious(chartRows(chart([{ label: "a", value: 1 }])))).toBe(false);
  });
  it("formatChartValue by unit", () => {
    expect(formatChartValue("percent", 22.605155)).toBe("22.6%");
    expect(formatChartValue("percent", 0.4321)).toBe("0.43%");
    expect(formatChartValue("normalized", 0.5)).toBe("0.50");
    expect(formatChartValue("mbps", 123.456)).toBe("123.5 Mbps");
    expect(formatChartValue("rank", 12.2)).toBe("#12");
    expect(formatChartValue("events", 3)).toBe("3");
  });
});

describe("groundingOf", () => {
  const base: TraceEvent[] = [
    { type: "run-start", runId: "r1", agent: "knowledge-base", model: "m", t: 0 },
    { type: "span-start", id: "r1", kind: "invoke_agent", name: "kb-agent", t: 0 },
  ];
  const checker = (detail: unknown, status: "ok" | "error" = "ok", end = true): TraceEvent[] => [
    { type: "span-start", id: "r1:grounding-checker:0", parentId: "r1", kind: "invoke_agent", name: "grounding-checker", t: 100 },
    ...(end
      ? ([{ type: "span-end", id: "r1:grounding-checker:0", t: 200, status, ...(detail !== undefined ? { detail } : {}) }] as TraceEvent[])
      : []),
  ];
  const run = (events: TraceEvent[]): RunTrace => events.reduce<RunTrace | null>((s, e) => reduceTrace(s, e), null) as RunTrace;

  it("null when there is no checker span", () => {
    expect(groundingOf(run(base))).toBeNull();
    expect(groundingOf(null)).toBeNull();
  });
  it("ok when nothing is unsupported", () => {
    expect(groundingOf(run([...base, ...checker({ unsupported: [] })]))).toEqual({ state: "ok" });
  });
  it("lists unsupported sentences (trimmed, non-empty strings only)", () => {
    const g = groundingOf(run([...base, ...checker({ unsupported: [" 年假 15 天 [2] ", "", 3, "第二句"] })]));
    expect(g).toEqual({ state: "unsupported", sentences: ["年假 15 天 [2]", "第二句"] });
  });
  it("parseError, missing detail and error status are 'incomplete'", () => {
    expect(groundingOf(run([...base, ...checker({ unsupported: [], parseError: true })]))).toEqual({ state: "incomplete" });
    expect(groundingOf(run([...base, ...checker(undefined)]))).toEqual({ state: "incomplete" });
    expect(groundingOf(run([...base, ...checker({ unsupported: [] }, "error")]))).toEqual({ state: "incomplete" });
  });
  it("checking while the span is still open", () => {
    expect(groundingOf(run([...base, ...checker(undefined, "ok", false)]))).toEqual({ state: "checking" });
  });
  it("ignores a same-named span that is not under the root", () => {
    const events: TraceEvent[] = [
      ...base,
      { type: "span-start", id: "x", parentId: "other", kind: "invoke_agent", name: "grounding-checker", t: 5 },
    ];
    expect(groundingOf(run(events))).toBeNull();
  });
});

describe("groupSources", () => {
  it("keeps every original number for repeated sources", () => {
    const groups = groupSources([
      { title: "a.md", url: "https://x/a", snippet: "1" },
      { title: "b.md", snippet: "2" },
      { title: "a.md", url: "https://x/a", snippet: "1b" },
      { title: "b.md", snippet: "2" },
    ]);
    expect(groups.map((g) => g.ns)).toEqual([[1, 3], [2, 4]]);
    expect(groups[0]!.source.title).toBe("a.md");
  });
});

describe("visibleOutputs (failed subagent attempts)", () => {
  const chart = (title: string) => ({
    kind: "bar" as const,
    title,
    unit: "percent",
    period: "7d",
    data: [{ label: "CN", value: 1 }],
    sourceUrl: "u",
  });
  // root R -> brief tool -> analyst :0 (fails after its tool charted) -> analyst :0r (succeeds, charts again)
  const events: TraceEvent[] = [
    { type: "run-start", runId: "R", agent: "threat-intel", model: "kimi-k2.6", t: 0 },
    { type: "span-start", id: "R", kind: "invoke_agent", name: "threat-intel-agent", t: 0 },
    { type: "span-start", id: "R/prefetch", parentId: "R", kind: "execute_tool", name: "attackers_of", t: 1 },
    { type: "chart", spanId: "R/prefetch", chart: chart("prefetch") },
    { type: "span-end", id: "R/prefetch", t: 2, status: "ok" },
    { type: "span-start", id: "R/brief", parentId: "R", kind: "execute_tool", name: "brief", t: 3 },
    { type: "span-start", id: "R/brief:attack-analyst:0", parentId: "R/brief", kind: "invoke_agent", name: "attack-analyst", t: 4 },
    { type: "span-start", id: "R/brief:attack-analyst:0/c1", parentId: "R/brief:attack-analyst:0", kind: "execute_tool", name: "attackers_of", t: 5 },
    { type: "chart", spanId: "R/brief:attack-analyst:0/c1", chart: chart("failed attempt") },
    { type: "citation", spanId: "R/brief:attack-analyst:0/c1", source: { title: "stale", snippet: "s" } },
    { type: "span-end", id: "R/brief:attack-analyst:0/c1", t: 6, status: "ok" },
    { type: "span-end", id: "R/brief:attack-analyst:0", t: 7, status: "error", detail: { error: "idle timeout" } },
    { type: "span-start", id: "R/brief:attack-analyst:0r", parentId: "R/brief", kind: "invoke_agent", name: "attack-analyst", t: 8 },
    { type: "span-start", id: "R/brief:attack-analyst:0r/c1", parentId: "R/brief:attack-analyst:0r", kind: "execute_tool", name: "attackers_of", t: 9 },
    { type: "chart", spanId: "R/brief:attack-analyst:0r/c1", chart: chart("retry") },
    { type: "citation", spanId: "R/brief:attack-analyst:0r/c1", source: { title: "fresh", snippet: "s" } },
    { type: "span-end", id: "R/brief:attack-analyst:0r/c1", t: 10, status: "ok" },
    { type: "span-end", id: "R/brief:attack-analyst:0r", t: 11, status: "ok" },
  ];
  const fold = (evs: TraceEvent[]): RunTrace => evs.reduce<RunTrace | null>((st, e) => reduceTrace(st, e), null) as RunTrace;
  const trace = fold(events);

  it("drops the failed attempt's chart and citation, keeps the retry's and the root's own", () => {
    const out = visibleOutputs(trace);
    expect(out.charts.map((c) => c.title)).toEqual(["prefetch", "retry"]);
    expect(out.citations.map((c) => c.title)).toEqual(["fresh"]);
  });

  it("keeps everything while no attempt has failed, and never hides a failed run's own root outputs", () => {
    const ok = events.filter((e) => !(e.type === "span-end" && e.id === "R/brief:attack-analyst:0"));
    const t1 = fold(ok);
    expect(visibleOutputs(t1).charts).toHaveLength(3);
    const failedRun = fold([...events, { type: "span-end", id: "R", t: 12, status: "error" } as TraceEvent]);
    expect(visibleOutputs(failedRun).charts.map((c) => c.title)).toEqual(["prefetch", "retry"]);
  });
});

describe("readKbResponse / kbFailureKey", () => {
  it("passes JSON bodies through", async () => {
    const ok = await readKbResponse(Response.json({ docs: [] }));
    expect(ok).toEqual({ ok: true, status: 200, body: { docs: [] }, blocked: false });
    const err = await readKbResponse(Response.json({ error: "agents.kb.errors.tooMany" }, { status: 400 }));
    expect(kbFailureKey(err)).toBe("agents.kb.errors.tooMany");
  });

  it("maps a Cloudflare challenge page (403 text/html) or any non-JSON body to blockedByWaf", async () => {
    const challenge = await readKbResponse(
      new Response("<!DOCTYPE html><title>Just a moment...</title>", {
        status: 403,
        headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" },
      }),
    );
    expect(challenge).toMatchObject({ ok: false, status: 403, blocked: true });
    expect(kbFailureKey(challenge)).toBe("agents.kb.errors.blockedByWaf");
    const garbage = await readKbResponse(new Response("not json", { status: 200 }));
    expect(garbage).toMatchObject({ ok: false, blocked: true });
  });
});
