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
