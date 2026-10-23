import { describe, expect, it } from "vitest";
import { createNdjsonParser, encodeEvent, type TraceEvent } from "./trace-events";

describe("encodeEvent", () => {
  it("serialises as JSON followed by a newline", () => {
    const e: TraceEvent = { type: "text-delta", spanId: "a", text: "hi" };
    const line = encodeEvent(e);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual(e);
  });
});

describe("createNdjsonParser", () => {
  const start = { type: "run-start", runId: "r1", agent: "kb", model: "m", t: 0 };
  const delta = { type: "text-delta", spanId: "a", text: "x" };

  it("buffers partial lines across chunks", () => {
    const p = createNdjsonParser();
    expect(p.push('{"type":"run-st')).toEqual([]);
    const out = p.push(
      'art","runId":"r1","agent":"kb","model":"m","t":0}\n' + JSON.stringify(delta) + "\n",
    );
    expect(out).toEqual([start, delta]);
  });

  it("flush() parses a final line without trailing newline", () => {
    const p = createNdjsonParser();
    expect(p.push(JSON.stringify(delta))).toEqual([]);
    expect(p.flush()).toEqual([delta]);
    expect(p.flush()).toEqual([]);
  });

  it("ignores empty lines", () => {
    const p = createNdjsonParser();
    expect(p.push("\n\n" + JSON.stringify(delta) + "\n\n")).toEqual([delta]);
    expect(p.flush()).toEqual([]);
  });

  it("handles CRLF and skips malformed lines", () => {
    const p = createNdjsonParser();
    expect(p.push("not json\r\n" + JSON.stringify(delta) + "\r\n")).toEqual([delta]);
  });
});
