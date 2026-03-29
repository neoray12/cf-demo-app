import type { Env } from "../types";

const BR_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

export async function handleBrowserRendering(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Extract endpoint: /api/browser-rendering/{endpoint}
  const endpoint = url.pathname.replace("/api/browser-rendering/", "");
  const validEndpoints = [
    "content",
    "screenshot",
    "pdf",
    "markdown",
    "snapshot",
    "scrape",
    "json",
    "links",
    "crawl",
  ];

  if (!validEndpoints.includes(endpoint)) {
    return new Response(
      JSON.stringify({ error: `Invalid endpoint: ${endpoint}` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const body = await request.text();
  const brUrl = `${BR_API_BASE}/${env.CF_ACCOUNT_ID}/browser-rendering/${endpoint}`;

  const brResponse = await fetch(brUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
  });

  // For binary responses (screenshot, pdf), pass through directly
  if (
    endpoint === "screenshot" ||
    endpoint === "pdf"
  ) {
    return new Response(brResponse.body, {
      status: brResponse.status,
      headers: {
        "Content-Type":
          brResponse.headers.get("Content-Type") || "application/octet-stream",
      },
    });
  }

  // For JSON responses, pass through
  const responseData = await brResponse.text();
  return new Response(responseData, {
    status: brResponse.status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
