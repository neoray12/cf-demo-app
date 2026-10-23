// Shared by server and browser: no server-only imports, no Node APIs.

export type SpanKind = "invoke_agent" | "chat" | "execute_tool";

export type TraceEvent =
  | { type: "run-start"; runId: string; agent: string; model: string; t: number }
  | { type: "span-start"; id: string; parentId?: string; kind: SpanKind; name: string; t: number }
  | {
      type: "span-end";
      id: string;
      t: number;
      status: "ok" | "error";
      usage?: { input: number; output: number };
      ttftMs?: number;
      detail?: unknown;
    }
  | { type: "reasoning-delta"; spanId: string; text: string }
  | { type: "text-delta"; spanId: string; text: string }
  | {
      type: "citation";
      spanId: string;
      source: { title: string; url?: string; snippet: string; score?: number };
    }
  | {
      type: "chart";
      spanId: string;
      chart: {
        kind: "bar" | "line";
        title: string;
        unit: string;
        period: string;
        data: { label: string; value: number }[];
        sourceUrl: string;
      };
    }
  | {
      type: "run-end";
      t: number;
      totalMs: number;
      ttftMs: number;
      usage: { input: number; output: number };
      status: "ok" | "error" | "aborted";
      error?: string;
    };

export type CitationEvent = Extract<TraceEvent, { type: "citation" }>;
export type ChartEvent = Extract<TraceEvent, { type: "chart" }>;

export function encodeEvent(e: TraceEvent): string {
  return JSON.stringify(e) + "\n";
}

/** Incremental NDJSON parser: tolerates chunks split mid-line; malformed lines are skipped. */
export function createNdjsonParser(): {
  push(chunk: string): TraceEvent[];
  flush(): TraceEvent[];
} {
  let buffer = "";

  const parseLine = (line: string, out: TraceEvent[]) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const v: unknown = JSON.parse(trimmed);
      if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string") {
        out.push(v as TraceEvent);
      }
    } catch {
      // ignore malformed line
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const out: TraceEvent[] = [];
      for (const line of lines) parseLine(line, out);
      return out;
    },
    flush() {
      const out: TraceEvent[] = [];
      parseLine(buffer, out);
      buffer = "";
      return out;
    },
  };
}
