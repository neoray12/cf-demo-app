// Folds /api/chat NDJSON events into one assistant message. Shared by the chat
// page (live streaming) and the server-side TurnRecorder (history), so a
// conversation restored from history renders exactly as it streamed.
import type { TimelineEvent } from './chat-timeline';
import { reduceTrace, type RunTrace } from './agents/trace-tree';
import type { TraceEvent } from './agents/trace-events';
import type { AutoRouting } from './auto-router';

export interface ToolCallInfo {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: 'calling' | 'done' | 'error';
  error?: string;
}

export type MessagePart =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string };

export interface TurnState {
  content: string;
  reasoning: string;
  toolCalls: ToolCallInfo[];
  /** Reasoning / text / tool calls in the order they actually happened. */
  parts: MessagePart[];
  /** Auto Router decision (model, reason code, IDs, candidate pool). */
  routedModel?: { model: string; reason: string | null } & Partial<Omit<AutoRouting, 'model' | 'reason'>>;
  notices: string[];
  /** Timestamped steps (ms since the turn started) for the processing timeline. */
  events: TimelineEvent[];
  /** Span tree (model calls, tools, subagents with time and tokens); null for turns from before span events. */
  trace: RunTrace | null;
}

export type ChatStreamEvent = { type: string; [key: string]: any };

export function createTurnState(): TurnState {
  return { content: '', reasoning: '', toolCalls: [], parts: [], notices: [], events: [], trace: null };
}

function appendPart(parts: MessagePart[], type: 'text' | 'reasoning', text: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.type === type) return [...parts.slice(0, -1), { type, text: last.text + text }];
  return [...parts, { type, text }];
}

// Some providers emit tool-call without a preceding tool-call-start.
function ensureTool(s: TurnState, id: string, name: string, t: number): TurnState {
  if (s.toolCalls.some((tc) => tc.id === id)) return s;
  return {
    ...s,
    toolCalls: [...s.toolCalls, { id, name, status: 'calling' }],
    parts: [...s.parts, { type: 'tool', id }],
    events: [...s.events, { t, kind: 'tool-start', id, name }],
  };
}

function updateTool(s: TurnState, id: string, patch: Partial<ToolCallInfo>): TurnState {
  return { ...s, toolCalls: s.toolCalls.map((tc) => (tc.id === id ? { ...tc, ...patch } : tc)) };
}

const SPAN_EVENTS = new Set(['run-start', 'span-start', 'span-end', 'span-input', 'run-end', 'citation', 'chart']);

/** Apply one stream event at `t` ms into the turn. Unknown events return the state unchanged. */
export function applyChatEvent(s: TurnState, ev: ChatStreamEvent, t: number): TurnState {
  if (SPAN_EVENTS.has(ev.type)) return { ...s, trace: reduceTrace(s.trace, ev as TraceEvent) };
  // Deltas tagged with a span are a subagent's live output: they belong to its
  // span (shown on its card), never to the answer.
  if ((ev.type === 'text-delta' || ev.type === 'reasoning-delta') && typeof ev.spanId === 'string') {
    return s.trace ? { ...s, trace: reduceTrace(s.trace, ev as TraceEvent) } : s;
  }
  switch (ev.type) {
    case 'text-delta':
    case 'reasoning-delta': {
      const text = typeof ev.text === 'string' ? ev.text : '';
      if (!text) return s;
      const kind = ev.type === 'text-delta' ? 'text' : 'reasoning';
      // Only the first of a run of same-kind deltas matters for step boundaries.
      const events = s.events[s.events.length - 1]?.kind === kind ? s.events : [...s.events, { t, kind } as TimelineEvent];
      return kind === 'text'
        ? { ...s, content: s.content + text, parts: appendPart(s.parts, 'text', text), events }
        : { ...s, reasoning: s.reasoning + text, parts: appendPart(s.parts, 'reasoning', text), events };
    }
    case 'tool-call-start':
      return ensureTool(s, ev.toolCallId, ev.toolName, t);
    case 'tool-call':
      return updateTool(ensureTool(s, ev.toolCallId, ev.toolName, t), ev.toolCallId, { args: ev.args });
    case 'tool-result': {
      const next = updateTool(ensureTool(s, ev.toolCallId, ev.toolName, t), ev.toolCallId, { status: 'done', result: ev.result });
      const outcome = (ev.result as { blocked?: unknown } | null)?.blocked === true ? 'blocked' : 'done';
      return { ...next, events: [...next.events, { t, kind: 'tool-end', id: ev.toolCallId, outcome }] };
    }
    case 'tool-error': {
      const next = updateTool(ensureTool(s, ev.toolCallId, ev.toolName, t), ev.toolCallId, { status: 'error', error: ev.error });
      return { ...next, events: [...next.events, { t, kind: 'tool-end', id: ev.toolCallId, outcome: 'error' }] };
    }
    case 'routed-model':
      return {
        ...s,
        routedModel: {
          model: ev.model,
          reason: ev.reason ?? null,
          ...Object.fromEntries(
            (['decisionId', 'requestId', 'logId', 'allowedProviders', 'allowedModels'] as const).filter((k) => ev[k] !== undefined).map((k) => [k, ev[k]]),
          ),
        },
      };
    case 'notice':
      return typeof ev.kind === 'string' && !s.notices.includes(ev.kind) ? { ...s, notices: [...s.notices, ev.kind] } : s;
    default:
      return s;
  }
}
