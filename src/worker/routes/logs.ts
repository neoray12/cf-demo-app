import type { Env } from "../types";

export async function handleLogs(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const path = url.pathname;

  // List R2 buckets via Cloudflare API
  if (path === "/api/logs/buckets" && request.method === "GET") {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets`,
      {
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
        },
      }
    );
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // List objects in a bucket (tree navigation with delimiter)
  if (path === "/api/logs/list" && request.method === "GET") {
    const bucket = url.searchParams.get("bucket");
    const prefix = url.searchParams.get("prefix") || "";
    const cursor = url.searchParams.get("cursor") || undefined;

    if (!bucket) {
      return new Response(
        JSON.stringify({ error: "bucket parameter required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Use S3-compatible API to list objects in any bucket
    const s3Url = new URL(
      `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}`
    );
    s3Url.searchParams.set("list-type", "2");
    s3Url.searchParams.set("delimiter", "/");
    if (prefix) s3Url.searchParams.set("prefix", prefix);
    if (cursor) s3Url.searchParams.set("continuation-token", cursor);
    s3Url.searchParams.set("max-keys", "100");

    const response = await fetch(s3Url.toString(), {
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    });

    if (!response.ok) {
      // Fallback: use Cloudflare API
      const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects?delimiter=/&prefix=${encodeURIComponent(prefix)}&per_page=100`;
      const apiResponse = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      });
      const data = await apiResponse.text();
      return new Response(data, {
        status: apiResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const xmlText = await response.text();
    // Parse S3 XML response
    const folders = [...xmlText.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)].map((m) => m[1]!);
    const files = [...xmlText.matchAll(/<Contents><Key>([^<]+)<\/Key><LastModified>([^<]+)<\/LastModified><Size>([^<]+)<\/Size>[^]*?<\/Contents>/g)].map((m) => ({
      key: m[1]!,
      lastModified: m[2]!,
      size: parseInt(m[3]!, 10),
    }));

    const isTruncated = xmlText.includes("<IsTruncated>true</IsTruncated>");
    const nextToken = xmlText.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] || null;

    return new Response(
      JSON.stringify({ folders, files, truncated: isTruncated, cursor: nextToken }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // Read a specific log file (with gzip decompression)
  if (path === "/api/logs/read" && request.method === "GET") {
    const bucket = url.searchParams.get("bucket");
    const key = url.searchParams.get("key");

    if (!bucket || !key) {
      return new Response(
        JSON.stringify({ error: "bucket and key parameters required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch from R2 via S3-compatible API
    const s3Url = `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
    const response = await fetch(s3Url, {
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `Failed to fetch: ${response.status}` }),
        { status: response.status, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if gzip compressed
    const isGzip =
      key.endsWith(".gz") ||
      response.headers.get("Content-Encoding") === "gzip";

    if (isGzip && response.body) {
      try {
        const ds = new DecompressionStream("gzip");
        const decompressed = response.body.pipeThrough(ds);
        const text = await new Response(decompressed).text();
        return new Response(
          JSON.stringify({ content: text, compressed: true }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch {
        // If decompression fails, return raw
        const text = await response.text();
        return new Response(
          JSON.stringify({ content: text, compressed: false }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const text = await response.text();
    return new Response(
      JSON.stringify({ content: text, compressed: false }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
