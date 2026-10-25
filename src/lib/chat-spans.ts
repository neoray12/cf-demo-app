// Main chat stream → Agents trace span events (src/lib/agents/trace-events.ts),
// so the chat page can show every model call and tool with its time and tokens.
// Subagents emit their own spans through the agents runtime under these tools.
import { toolSpanId } from './agents/runtime';
import type { TraceEvent } from './agents/trace-events';
import { MAIN_ROOT_SPAN } from './trace-summary';

export { MAIN_ROOT_SPAN };

export interface GatewayInfo {
  logId: string | null;
  cacheStatus: string | null;
  ray: string | null;
  routedModel: string | null;
}

export interface ChatSpanTracker {
  start(t: number): TraceEvent[];
  onPart(part: { type: string; [k: string]: unknown }, t: number, gateway?: GatewayInfo): TraceEvent[];
  end(t: number, status: 'ok' | 'error' | 'aborted', error?: string): TraceEvent[];
  usage(): { input: number; output: number };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function createChatSpanTracker(opts: { model: string; traced: boolean }): ChatSpanTracker {
  let startT = 0;
  let step = 0;
  let chat: { id: string; start: number; firstAt: number | null } | null = null;
  let firstAnswerAt: number | null = null;
  const openTools = new Map<string, string>(); // toolCallId → span id
  const total = { input: 0, output: 0 };

  const openTool = (callId: string, name: string, t: number, out: TraceEvent[]) => {
    if (openTools.has(callId)) return;
    const id = toolSpanId(MAIN_ROOT_SPAN, callId);
    openTools.set(callId, id);
    out.push({ type: 'span-start', id, parentId: MAIN_ROOT_SPAN, kind: 'execute_tool', name, t });
  };

  return {
    start(t) {
      startT = t;
      return [
        { type: 'run-start', runId: MAIN_ROOT_SPAN, agent: 'main-chat', model: opts.model, t, traced: opts.traced },
        { type: 'span-start', id: MAIN_ROOT_SPAN, kind: 'invoke_agent', name: 'main-chat', t },
      ];
    },

    onPart(part, t, gateway) {
      const out: TraceEvent[] = [];
      switch (part.type) {
        case 'start-step':
          step += 1;
          chat = { id: `${MAIN_ROOT_SPAN}/step-${step}`, start: t, firstAt: null };
          out.push({ type: 'span-start', id: chat.id, parentId: MAIN_ROOT_SPAN, kind: 'chat', name: `chat ${opts.model}`, t });
          break;
        case 'text-delta':
        case 'reasoning-delta':
          if (chat && chat.firstAt === null && part.text) chat.firstAt = t;
          if (part.type === 'text-delta' && firstAnswerAt === null && part.text) firstAnswerAt = t;
          break;
        case 'tool-input-start':
          openTool(String(part.id), String(part.toolName), t, out);
          break;
        case 'tool-call':
          openTool(String(part.toolCallId), String(part.toolName), t, out);
          out.push({ type: 'span-input', id: openTools.get(String(part.toolCallId))!, input: part.input });
          break;
        case 'tool-result':
        case 'tool-error': {
          const callId = String(part.toolCallId);
          openTool(callId, String(part.toolName), t, out);
          const id = openTools.get(callId)!;
          openTools.delete(callId);
          if (part.type === 'tool-error') {
            out.push({ type: 'span-end', id, t, status: 'error', detail: { error: String((part.error as Error)?.message ?? part.error) } });
          } else {
            const blocked = (part.output as { blocked?: unknown } | null)?.blocked === true;
            out.push({ type: 'span-end', id, t, status: 'ok', ...(blocked ? { detail: { blocked: true } } : {}) });
          }
          break;
        }
        case 'finish-step': {
          if (!chat) break;
          const u = (part.usage ?? {}) as Record<string, unknown>;
          const usage = { input: num(u.inputTokens), output: num(u.outputTokens) };
          total.input += usage.input;
          total.output += usage.output;
          out.push({
            type: 'span-end',
            id: chat.id,
            t,
            status: 'ok',
            usage,
            ...(chat.firstAt !== null ? { ttftMs: chat.firstAt - chat.start } : {}),
            detail: {
              finishReason: part.finishReason ?? null,
              ...(u.reasoningTokens !== undefined ? { reasoningTokens: num(u.reasoningTokens) } : {}),
              ...(u.cachedInputTokens !== undefined ? { cachedInputTokens: num(u.cachedInputTokens) } : {}),
              ...(gateway ? { gateway } : {}),
            },
          });
          chat = null;
          break;
        }
      }
      return out;
    },

    end(t, status, error) {
      const out: TraceEvent[] = [];
      const reason = status === 'ok' ? 'not finished' : status;
      for (const id of [...openTools.values()].reverse()) out.push({ type: 'span-end', id, t, status: 'error', detail: { error: reason } });
      openTools.clear();
      if (chat) out.push({ type: 'span-end', id: chat.id, t, status: 'error', detail: { error: reason } });
      chat = null;
      out.push({ type: 'span-end', id: MAIN_ROOT_SPAN, t, status: status === 'ok' ? 'ok' : 'error', ...(error ? { detail: { error } } : {}) });
      out.push({
        type: 'run-end',
        t,
        totalMs: t - startT,
        ttftMs: firstAnswerAt === null ? 0 : firstAnswerAt - startT,
        usage: { ...total },
        status,
        ...(error ? { error } : {}),
      });
      return out;
    },

    usage() {
      return { ...total };
    },
  };
}
