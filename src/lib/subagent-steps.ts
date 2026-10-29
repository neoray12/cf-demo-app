// The step-by-step view of an `ask_<server>` call for the subagent card: tool
// loading, each model call (live reasoning / text), each tool call with its
// arguments (a Code Mode script shows up while the model writes it), its result
// and, for Code Mode, the inner steps the script logged (portal-catalog.ts).
import type { RunTrace, SpanNode } from './agents/trace-tree';
import { MAIN_ROOT_SPAN } from './trace-summary';

type Status = 'running' | 'done' | 'error';

/** One call made inside a Code Mode script, as the script logged it (`steps.push(...)`). */
export interface CodeStep {
  tool: string;
  args?: unknown;
  n?: number;
  ms?: number;
  error?: string;
}

export type SubagentStep =
  | { kind: 'prepare'; name: string; status: Status; durationMs: number }
  | {
      kind: 'model';
      index: number;
      status: Status;
      durationMs: number;
      ttftMs?: number;
      inputTokens: number;
      outputTokens: number;
      text: string;
      reasoning: string;
    }
  | {
      kind: 'tool';
      name: string;
      /** writing = the model is still writing the arguments; approval = held back for a human. */
      status: 'writing' | 'running' | 'done' | 'error' | 'approval' | 'blocked';
      durationMs: number;
      code?: string;
      args?: unknown;
      output?: unknown;
      error?: string;
      approvalId?: string;
      innerSteps?: CodeStep[];
      result?: unknown;
      resultText?: string;
    };

export interface SubagentSteps {
  running: boolean;
  durationMs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** The subagent failed once and was run again (only the latest attempt's steps are listed). */
  retried: boolean;
  steps: SubagentStep[];
}

const INNER_STEPS_MAX = 50;

const elapsed = (n: SpanNode, now: number) => (n.end ?? Math.max(n.start, now)) - n.start;
const statusOf = (n: SpanNode): Status => (n.end === null ? 'running' : n.status === 'error' ? 'error' : 'done');
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The value of string field `key` in JSON that may be cut off mid-way (tool arguments
 * while the model writes them). A cut-off escape at the end is dropped; null until the
 * value has started.
 */
export function partialJsonString(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!m) return null;
  let out = '';
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = text[i + 1];
    if (e === undefined) return out;
    if (e === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e;
    i += 1;
  }
  return out;
}

function codeStep(v: unknown): CodeStep | null {
  if (!isObject(v)) return null;
  const tool = [v.tool, v.name, v.call].find((x) => typeof x === 'string') as string | undefined;
  if (!tool) return null;
  const step: CodeStep = { tool };
  const args = v.args ?? v.input;
  if (args !== undefined) step.args = args;
  const n = [v.n, v.count, v.rows].find((x) => typeof x === 'number') as number | undefined;
  if (n !== undefined) step.n = n;
  const ms = [v.ms, v.duration].find((x) => typeof x === 'number') as number | undefined;
  if (ms !== undefined) step.ms = ms;
  if (typeof v.error === 'string') step.error = v.error;
  return step;
}

function withSteps(v: Record<string, unknown>): { innerSteps: CodeStep[]; result?: unknown } {
  const innerSteps = (v.steps as unknown[]).map(codeStep).filter((s): s is CodeStep => s !== null).slice(0, INNER_STEPS_MAX);
  const { steps: _steps, ...rest } = v;
  return 'result' in v ? { innerSteps, result: v.result } : { innerSteps, result: rest };
}

/**
 * A Code Mode execute result: the Portal returns `{ result: "<JSON text>" }`; a script that
 * logged its calls returns `{ steps, result }` inside it.
 */
export function parseCodeResult(output: unknown): { resultText?: string; result?: unknown; innerSteps?: CodeStep[] } {
  if (isObject(output) && typeof output.result === 'string') {
    let v: unknown;
    try {
      v = JSON.parse(output.result);
    } catch {
      return { resultText: output.result };
    }
    return isObject(v) && Array.isArray(v.steps) ? withSteps(v) : { result: v };
  }
  if (isObject(output) && Array.isArray(output.steps)) return withSteps(output);
  return { result: output };
}

function toolStep(n: SpanNode, now: number): SubagentStep {
  const detail = isObject(n.detail) ? n.detail : {};
  const output = detail.output;
  const args = n.input ?? detail.input;
  const code =
    isObject(args) && typeof args.code === 'string'
      ? args.code
      : n.inputText !== undefined
        ? (partialJsonString(n.inputText, 'code') ?? undefined)
        : undefined;
  let status: Extract<SubagentStep, { kind: 'tool' }>['status'] =
    n.end === null ? (n.input === undefined ? 'writing' : 'running') : n.status === 'error' ? 'error' : 'done';
  const step: Extract<SubagentStep, { kind: 'tool' }> = { kind: 'tool', name: n.name, status, durationMs: elapsed(n, now) };
  if (code !== undefined) step.code = code;
  else if (args !== undefined) step.args = args;
  if (typeof detail.error === 'string') step.error = detail.error;
  if (isObject(output) && output.pendingApproval === true) {
    status = 'approval';
    if (typeof output.approvalId === 'string') step.approvalId = output.approvalId;
  } else if (isObject(output) && output.blocked === true) {
    status = 'blocked';
  }
  step.status = status;
  if (output !== undefined && status !== 'approval') {
    if (code !== undefined) Object.assign(step, parseCodeResult(output));
    else step.output = output;
  }
  return step;
}

/** The subagent behind the `ask_<server>` tool call `toolCallId`, or null before its span exists. */
export function subagentSteps(trace: RunTrace, toolCallId: string, now: number): SubagentSteps | null {
  const delegate = trace.spans[`${MAIN_ROOT_SPAN}/${toolCallId}`];
  if (!delegate) return null;
  const attempts = delegate.children.filter((c) => c.kind === 'invoke_agent').sort((a, b) => a.start - b.start);
  const agent = attempts[attempts.length - 1];
  const view: SubagentSteps = {
    running: delegate.end === null,
    durationMs: elapsed(delegate, now),
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    retried: attempts.length > 1,
    steps: [],
  };
  for (const c of [...delegate.children].sort((a, b) => a.start - b.start)) {
    if (c.kind === 'execute_tool') view.steps.push({ kind: 'prepare', name: c.name, status: statusOf(c), durationMs: elapsed(c, now) });
  }
  for (const a of attempts) {
    for (const c of a.children) {
      if (c.kind !== 'chat') continue;
      view.modelCalls += 1;
      view.inputTokens += c.usage?.input ?? 0;
      view.outputTokens += c.usage?.output ?? 0;
    }
  }
  if (!agent) return view;
  let index = 0;
  for (const c of [...agent.children].sort((a, b) => a.start - b.start)) {
    if (c.kind === 'chat') {
      view.steps.push({
        kind: 'model',
        index: ++index,
        status: statusOf(c),
        durationMs: elapsed(c, now),
        ...(c.ttftMs !== undefined ? { ttftMs: c.ttftMs } : {}),
        inputTokens: c.usage?.input ?? 0,
        outputTokens: c.usage?.output ?? 0,
        text: c.text,
        reasoning: c.reasoning,
      });
    } else if (c.kind === 'execute_tool') {
      view.steps.push(toolStep(c, now));
    }
  }
  return view;
}
