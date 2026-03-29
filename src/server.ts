import { routeAgentRequest } from "agents";
import type { Env } from "./worker/types";
import { handleApiRoute } from "./worker/routes/api";

// Re-export the ChatAgent class so the runtime can find it
export { ChatAgent } from "./worker/agent";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Agent WebSocket routing (handles /agents/*)
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // 2. API routes (/api/*)
    if (url.pathname.startsWith("/api/")) {
      return handleApiRoute(request, env, url);
    }

    // 3. Static assets (SPA fallback handled by wrangler config)
    return env.ASSETS.fetch(request);
  },
};
