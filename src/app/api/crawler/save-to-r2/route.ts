import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

// ── Content sanitization for AI Search (AutoRAG) embedding ──

function sanitizeHtml(raw: string): string {
  let text = raw;
  const blockTags = ['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'header', 'footer', 'aside'];
  for (const tag of blockTags) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }
  text = text.replace(/<(link|meta|input|br|hr|img)[^>]*\/?>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#\d+;/g, '');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  return text.trim();
}

function sanitizeMarkdown(raw: string): string {
  let text = raw;
  text = text.replace(/^!\[\]\([^\)]+\)\s*$/gm, '');
  text = text.replace(/^\[([^\]]*)\]\([^\)]+\)\s*$/gm, (_, label) => {
    if (label && label.trim().length > 3 && !/^[\s→←▶◀↗↘►]+$/.test(label.trim())) return label.trim();
    return '';
  });
  text = text.replace(/(\n\[.+?\]\(.+?\)\s*){5,}/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function sanitizeForRag(raw: string, contentType: string): { content: string; contentType: string; ext: string } {
  if (contentType === 'text/html' || contentType.includes('html')) {
    return { content: sanitizeHtml(raw), contentType: 'text/plain', ext: 'txt' };
  }
  if (contentType === 'text/markdown' || contentType.includes('markdown')) {
    return { content: sanitizeMarkdown(raw), contentType: 'text/markdown', ext: 'md' };
  }
  return { content: raw, contentType, ext: '' };
}

export async function POST(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { content, sourceUrl, contentType, filename } = await request.json();

  const sanitized = sanitizeForRag(content, contentType);
  const finalFilename = sanitized.ext && !filename.endsWith(`.${sanitized.ext}`)
    ? filename.replace(/\.[^.]+$/, `.${sanitized.ext}`)
    : filename;

  await (env as any).CRAWLER_BUCKET.put(finalFilename, sanitized.content, {
    httpMetadata: { contentType: sanitized.contentType },
    customMetadata: { sourceUrl, crawledAt: new Date().toISOString() },
  });

  // Trigger AI Search index job (fire-and-forget)
  let indexJobId: string | null = null;
  try {
    const syncRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${(env as any).CF_ACCOUNT_ID}/ai-search/instances/${(env as any).AUTORAG_NAME}/jobs`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${(env as any).CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: '{}',
      }
    );
    const syncData = (await syncRes.json()) as { success?: boolean; result?: { id?: string } };
    if (syncData.success && syncData.result?.id) indexJobId = syncData.result.id;
  } catch { /* Non-critical */ }

  return Response.json({ success: true, key: finalFilename, indexJobId });
}
