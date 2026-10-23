// Validation of the POST /api/agents/[agentId] body (kept out of route.ts: Next route modules may only export handlers).

export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_TOTAL_CHARS = 32_000;
export const MAX_CONVERSATION_ID_CHARS = 100;
const CONVERSATION_ID_RE = /^[\w-]+$/;

export interface AgentMessageInput {
  role: "user" | "assistant";
  content: string;
}

export type AgentRequestCheck =
  | { ok: true; messages: AgentMessageInput[]; conversationId: string }
  | { ok: false; error: string };

/**
 * Caps on what one request may send to the model: ≤ 20 messages, ≤ 8000 chars each, ≤ 32000 in total, roles
 * user / assistant only, the last one from the user, and a short `[\w-]+` conversationId (it goes into
 * telemetry metadata and the AI Gateway session header).
 */
export function checkAgentRequest(body: { messages?: unknown; conversationId?: unknown }): AgentRequestCheck {
  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "messages must be a non-empty array" };
  if (raw.length > MAX_MESSAGES) return { ok: false, error: `messages: at most ${MAX_MESSAGES} allowed` };
  const messages: AgentMessageInput[] = [];
  let total = 0;
  for (const [i, m] of raw.entries()) {
    const role = (m as { role?: unknown } | null)?.role;
    const content = (m as { content?: unknown } | null)?.content;
    if (role !== "user" && role !== "assistant") return { ok: false, error: `messages[${i}].role must be user or assistant` };
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: `messages[${i}].content must be a non-empty string` };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, error: `messages[${i}].content exceeds ${MAX_MESSAGE_CHARS} characters` };
    }
    total += content.length;
    messages.push({ role, content });
  }
  if (total > MAX_TOTAL_CHARS) return { ok: false, error: `messages exceed ${MAX_TOTAL_CHARS} characters in total` };
  if (messages.at(-1)!.role !== "user") return { ok: false, error: "the last message must be from the user" };

  const id = body.conversationId;
  if (typeof id !== "string" || !id) return { ok: false, error: "conversationId is required" };
  if (id.length > MAX_CONVERSATION_ID_CHARS || !CONVERSATION_ID_RE.test(id)) {
    return { ok: false, error: `conversationId must match [A-Za-z0-9_-] and be at most ${MAX_CONVERSATION_ID_CHARS} characters` };
  }
  return { ok: true, messages, conversationId: id };
}
