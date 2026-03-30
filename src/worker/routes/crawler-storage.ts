import type { Env } from "../types";

// ── Content sanitization for AI Search (AutoRAG) embedding ──

/**
 * Strip HTML to clean text for embedding.
 * Removes script/style/nav/header/footer/aside/iframe/noscript blocks,
 * then strips remaining tags, collapses whitespace, and trims.
 */
function sanitizeHtml(raw: string): string {
  let text = raw;
  // Remove entire blocks of non-content elements (tag + inner content)
  const blockTags = [
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    "nav",
    "header",
    "footer",
    "aside",
  ];
  for (const tag of blockTags) {
    text = text.replace(
      new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
      "",
    );
  }
  // Remove self-closing / void non-content tags (e.g. <link>, <meta>)
  text = text.replace(/<(link|meta|input|br|hr|img)[^>]*\/?>/gi, "");
  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#\d+;/g, "");
  // Collapse whitespace: multiple spaces/tabs → single space, multiple newlines → double
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n\s*\n/g, "\n\n");
  return text.trim();
}

/**
 * Clean Markdown for embedding.
 * Strips navigation-heavy link lists, bare image references, and excessive whitespace.
 */
function sanitizeMarkdown(raw: string): string {
  let text = raw;
  // Remove lines that are only image references with no alt-text content
  text = text.replace(/^!\[\]\([^\)]+\)\s*$/gm, "");
  // Remove lines that are only a markdown link (navigation links)
  text = text.replace(/^\[([^\]]*)\]\([^\)]+\)\s*$/gm, (_, label) => {
    // Keep if the label has meaningful content (> 3 chars, not just an icon/arrow)
    if (label && label.trim().length > 3 && !/^[\s→←▶◀↗↘►]+$/.test(label.trim())) {
      return label.trim();
    }
    return "";
  });
  // Remove consecutive navigation-style link lines (e.g. menu items)
  // A block of 5+ consecutive lines that are just links → remove
  text = text.replace(
    /(\n\[.+?\]\(.+?\)\s*){5,}/g,
    "\n",
  );
  // Collapse excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * Sanitize content before storing in R2 for AI Search indexing.
 * Returns { content, contentType } — HTML is converted to text/plain.
 */
function sanitizeForRag(
  raw: string,
  contentType: string,
): { content: string; contentType: string; ext: string } {
  if (contentType === "text/html" || contentType.includes("html")) {
    return {
      content: sanitizeHtml(raw),
      contentType: "text/plain",
      ext: "txt",
    };
  }
  if (contentType === "text/markdown" || contentType.includes("markdown")) {
    return {
      content: sanitizeMarkdown(raw),
      contentType: "text/markdown",
      ext: "md",
    };
  }
  // JSON and other formats: store as-is
  return { content: raw, contentType, ext: "" };
}

// ── Route handlers ──

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

    // Sanitize content for AI Search embedding
    const sanitized = sanitizeForRag(content, contentType);
    // If HTML was converted to text, update the filename extension
    const finalFilename =
      sanitized.ext && !filename.endsWith(`.${sanitized.ext}`)
        ? filename.replace(/\.[^.]+$/, `.${sanitized.ext}`)
        : filename;

    const date = new Date().toISOString().split("T")[0];
    const slug = new URL(sourceUrl).hostname.replace(/\./g, "_");
    const key = `crawled/${date}/${slug}_${finalFilename}`;

    await env.CRAWLER_BUCKET.put(key, sanitized.content, {
      httpMetadata: { contentType: sanitized.contentType },
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
