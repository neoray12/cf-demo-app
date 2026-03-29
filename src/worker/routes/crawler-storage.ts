import type { Env } from "../types";

export async function handleCrawlerStorage(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/crawler/save-to-r2" && request.method === "POST") {
    const { content, sourceUrl, contentType, filename } = (await request.json()) as {
      content: string;
      sourceUrl: string;
      contentType: string;
      filename: string;
    };

    const date = new Date().toISOString().split("T")[0];
    const slug = new URL(sourceUrl).hostname.replace(/\./g, "_");
    const key = `crawled/${date}/${slug}_${filename}`;

    await env.CRAWLER_BUCKET.put(key, content, {
      httpMetadata: { contentType },
      customMetadata: {
        sourceUrl,
        crawledAt: new Date().toISOString(),
      },
    });

    return new Response(
      JSON.stringify({ success: true, key }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  if (path === "/api/crawler/list" && request.method === "GET") {
    const prefix = url.searchParams.get("prefix") || "crawled/";
    const cursor = url.searchParams.get("cursor") || undefined;

    const listed = await env.CRAWLER_BUCKET.list({
      prefix,
      limit: 50,
      cursor,
    });

    const files = listed.objects.map((obj: R2Object) => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
      customMetadata: obj.customMetadata,
    }));

    return new Response(
      JSON.stringify({
        files,
        truncated: listed.truncated,
        cursor: listed.truncated ? listed.cursor : null,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
