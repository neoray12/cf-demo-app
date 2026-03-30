import type { Env } from "../types";
import { handleBrowserRendering } from "./browser-rendering";
import { handleChat } from "./chat";
import { handleCrawlerStorage } from "./crawler-storage";
import { handleLogs } from "./logs";

export async function handleApiRoute(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const path = url.pathname;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let response: Response;

    if (path.startsWith("/api/chat")) {
      response = await handleChat(request, env);
    } else if (path.startsWith("/api/browser-rendering/")) {
      response = await handleBrowserRendering(request, env, url);
    } else if (path.startsWith("/api/crawler/")) {
      response = await handleCrawlerStorage(request, env, url);
    } else if (path.startsWith("/api/logs/")) {
      response = await handleLogs(request, env, url);
    } else {
      response = new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Add CORS headers to response
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
}
