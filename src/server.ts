import type { Env } from "./worker/types";
import { handleApiRoute } from "./worker/routes/api";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. API routes (/api/*)
    if (url.pathname.startsWith("/api/")) {
      return handleApiRoute(request, env, url);
    }

    // 2. Static assets are handled by @cloudflare/vite-plugin (dev) and Cloudflare edge (prod)
    return new Response("Not Found", { status: 404 });
  },
};
