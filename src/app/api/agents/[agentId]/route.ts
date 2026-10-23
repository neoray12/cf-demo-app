import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { NextRequest } from "next/server";
import { AGENT_IDS, type AgentId } from "@/lib/agents/ids";
import { AGENT_MODELS, type ModelKey } from "@/lib/agents/models";
import { AGENTS } from "@/lib/agents/registry";
import { errorMessage, runAgent, type AgentEnv, type RunContext } from "@/lib/agents/runtime";
import { checkAgentRequest } from "@/lib/agents/request";
import { encodeEvent } from "@/lib/agents/trace-events";
import { getTracedAI, isTracingActive } from "@/lib/agents/tracing";

export const dynamic = "force-dynamic";

interface AgentRequestBody {
  messages?: unknown;
  model?: string;
  conversationId?: unknown;
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

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "Body must be a JSON object" }, 400);
  }
  const body = parsed as AgentRequestBody;

  const check = checkAgentRequest(body);
  if (!check.ok) return json({ error: check.error }, 400);
  const { messages, conversationId } = check;
  // Object.hasOwn: "constructor" / "toString" / "__proto__" must not pass as model keys.
  const modelKey: ModelKey =
    typeof body.model === "string" && Object.hasOwn(AGENT_MODELS, body.model) ? (body.model as ModelKey) : def.defaultModel;
  const storeContent = typeof body.storeContent === "boolean" ? body.storeContent : true;

  let agentEnv: AgentEnv;
  try {
    const { env } = await getCloudflareContext();
    const e = env as unknown as Record<string, unknown>;
    agentEnv = {
      ...e,
      CF_ACCOUNT_ID: (e.CF_ACCOUNT_ID as string) || "5efa272dc28e4e3933324c44165b6dbe",
      AI_GATEWAY_ID: (e.AI_GATEWAY_ID as string) || "nkcf-gateway-01",
    } as unknown as AgentEnv;
  } catch (err) {
    return json({ error: `Failed to load Cloudflare context: ${errorMessage(err)}` }, 500);
  }

  // Abort when the client disconnects (request.signal) or cancels the stream.
  const abort = new AbortController();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  let ai: Awaited<ReturnType<typeof getTracedAI>>;
  try {
    ai = await getTracedAI({ storeContent });
  } catch (err) {
    return json({ error: `Failed to initialise tracing: ${errorMessage(err)}` }, 500);
  }
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
        conversationId,
        storeContent,
        workspace: typeof body.workspace === "string" ? body.workspace : undefined,
        signal: abort.signal,
        traced: isTracingActive(),
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
