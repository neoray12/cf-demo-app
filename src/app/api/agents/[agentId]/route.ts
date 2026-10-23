import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { NextRequest } from "next/server";
import { AGENT_IDS, type AgentId } from "@/lib/agents/ids";
import { AGENT_MODELS, type ModelKey } from "@/lib/agents/models";
import { AGENTS } from "@/lib/agents/registry";
import { runAgent, type AgentEnv, type RunContext } from "@/lib/agents/runtime";
import { encodeEvent } from "@/lib/agents/trace-events";
import { getTracedAI } from "@/lib/agents/tracing";

export const dynamic = "force-dynamic";

interface AgentRequestBody {
  messages?: Array<{ role?: string; content?: unknown }>;
  model?: string;
  conversationId?: string;
  workspace?: string;
  storeContent?: boolean;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const def = (AGENT_IDS as readonly string[]).includes(agentId) ? AGENTS[agentId as AgentId] : undefined;
  if (!def) return json({ error: `Unknown agent: ${agentId}` }, 404);

  let body: AgentRequestBody;
  try {
    body = (await request.json()) as AgentRequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const messages = Array.isArray(body.messages)
    ? body.messages.filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.length > 0,
      )
    : [];
  if (messages.length === 0) return json({ error: "messages must be a non-empty array" }, 400);
  if (typeof body.conversationId !== "string" || !body.conversationId) {
    return json({ error: "conversationId is required" }, 400);
  }
  const modelKey: ModelKey =
    body.model && body.model in AGENT_MODELS ? (body.model as ModelKey) : def.defaultModel;
  const storeContent = body.storeContent ?? true;

  const { env } = await getCloudflareContext();
  const e = env as unknown as Record<string, unknown>;
  const agentEnv = {
    ...e,
    CF_ACCOUNT_ID: (e.CF_ACCOUNT_ID as string) || "5efa272dc28e4e3933324c44165b6dbe",
    AI_GATEWAY_ID: (e.AI_GATEWAY_ID as string) || "nkcf-gateway-01",
  } as unknown as AgentEnv;

  // Abort when the client disconnects (request.signal) or cancels the stream.
  const abort = new AbortController();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const ai = await getTracedAI({ storeContent });
  const start = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const ctx: RunContext = {
        env: agentEnv,
        ai,
        emit: (ev) => {
          try {
            controller.enqueue(encoder.encode(encodeEvent(ev)));
          } catch {
            // stream already closed/cancelled
          }
        },
        now: () => Date.now() - start,
        conversationId: body.conversationId!,
        storeContent,
        workspace: typeof body.workspace === "string" ? body.workspace : undefined,
        signal: abort.signal,
      };
      await runAgent(def, messages, modelKey, ctx);
      try {
        controller.close();
      } catch {
        // already closed by cancel()
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
