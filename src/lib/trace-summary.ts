// One-line numbers for a chat turn's span tree: time, first token, model calls,
// tools, subagents and tokens (main agent + subagents).
import type { RunTrace } from './agents/trace-tree';

export interface TraceSummary {
  totalMs: number;
  ttftMs: number | null;
  modelCalls: number;
  toolCalls: number;
  subagents: number;
  inputTokens: number;
  outputTokens: number;
}

/** Deterministic harness steps (connections, uploads, saves) are spans too, but not tool calls. */
export const HARNESS_STEP = /^(sandbox|mcp|history)\./;

export function summarizeTrace(trace: RunTrace): TraceSummary {
  const s: TraceSummary = { totalMs: 0, ttftMs: null, modelCalls: 0, toolCalls: 0, subagents: 0, inputTokens: 0, outputTokens: 0 };
  let lastEnd = 0;
  for (const node of Object.values(trace.spans)) {
    if (node.kind === 'chat') {
      s.modelCalls += 1;
      s.inputTokens += node.usage?.input ?? 0;
      s.outputTokens += node.usage?.output ?? 0;
    } else if (node.kind === 'execute_tool' && !HARNESS_STEP.test(node.name)) {
      s.toolCalls += 1;
    } else if (node.kind === 'invoke_agent' && node.parentId !== undefined) {
      s.subagents += 1;
    }
    lastEnd = Math.max(lastEnd, node.end ?? node.start);
  }
  s.totalMs = trace.totalMs ?? lastEnd;
  s.ttftMs = trace.ttftMs ? trace.ttftMs : null;
  return s;
}

const secs = (ms: number) => (ms / 1000).toFixed(1);
const count = (n: number) => n.toLocaleString('en-US');

export function formatSummary(s: TraceSummary, lang: 'zh-TW' | 'en'): string {
  const zh = lang === 'zh-TW';
  const parts = [zh ? `共 ${secs(s.totalMs)} 秒` : `${secs(s.totalMs)} s total`];
  if (s.ttftMs !== null) parts.push(zh ? `首字 ${secs(s.ttftMs)} 秒` : `first token ${secs(s.ttftMs)} s`);
  parts.push(zh ? `${s.modelCalls} 次模型呼叫` : `${s.modelCalls} model calls`);
  parts.push(zh ? `${s.toolCalls} 個工具` : `${s.toolCalls} tools`);
  if (s.subagents > 0) parts.push(zh ? `${s.subagents} 個 subagent` : `${s.subagents} subagents`);
  parts.push(
    zh
      ? `輸入 ${count(s.inputTokens)} / 輸出 ${count(s.outputTokens)} tokens`
      : `${count(s.inputTokens)} in / ${count(s.outputTokens)} out tokens`,
  );
  return parts.join(' · ');
}

/** Root span id of a main-chat turn (chat-spans.ts); a delegate tool's span is `${MAIN_ROOT_SPAN}/${toolCallId}`. */
export const MAIN_ROOT_SPAN = 'main';

export interface SubagentView {
  running: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  tools: Array<{ name: string; status: 'running' | 'done' | 'error'; durationMs: number }>;
  /** The end of the subagent's latest model output (live progress). */
  tail: string;
}

const TAIL_CHARS = 160;

/** The subagent run behind an `ask_<server>` tool call (its latest attempt), or null before it starts. */
export function subagentView(trace: RunTrace, toolCallId: string, sNow: number): SubagentView | null {
  const delegate = trace.spans[`${MAIN_ROOT_SPAN}/${toolCallId}`];
  const agent = delegate?.children.filter((c) => c.kind === 'invoke_agent').sort((a, b) => b.start - a.start)[0];
  if (!agent) return null;
  const view: SubagentView = {
    running: agent.end === null,
    durationMs: (agent.end ?? Math.max(agent.start, sNow)) - agent.start,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    tools: [],
    tail: '',
  };
  let lastChat: (typeof agent.children)[number] | undefined;
  for (const child of [...agent.children].sort((a, b) => a.start - b.start)) {
    if (child.kind === 'chat') {
      view.modelCalls += 1;
      view.inputTokens += child.usage?.input ?? 0;
      view.outputTokens += child.usage?.output ?? 0;
      lastChat = child;
    } else if (child.kind === 'execute_tool') {
      view.tools.push({
        name: child.name,
        status: child.end === null ? 'running' : child.status === 'error' ? 'error' : 'done',
        durationMs: (child.end ?? Math.max(child.start, sNow)) - child.start,
      });
    }
  }
  if (view.running && lastChat) view.tail = lastChat.text.slice(-TAIL_CHARS);
  return view;
}
