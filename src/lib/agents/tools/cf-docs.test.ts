import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedDocUrl, parseDocsSearchResult } from "./cf-docs";

const fixture = readFileSync(join(__dirname, "__fixtures__", "cf-docs-search.txt"), "utf8");

describe("parseDocsSearchResult", () => {
  it("parses <result> blocks from the cf-docs MCP search output", () => {
    const results = parseDocsSearchResult(fixture);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.url.startsWith("https://developers.cloudflare.com/")).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.snippet.length).toBeLessThanOrEqual(600);
    }
  });

  it("returns [] for text without result blocks", () => {
    expect(parseDocsSearchResult("no results")).toEqual([]);
  });
});

describe("isAllowedDocUrl", () => {
  it("allows developers.cloudflare.com over https", () => {
    expect(isAllowedDocUrl("https://developers.cloudflare.com/workers/")).toBe(true);
  });
  it.each([
    "http://developers.cloudflare.com/",
    "https://developers.cloudflare.com.evil.com/",
    "https://evil.com/?u=https://developers.cloudflare.com/",
    "javascript:alert(1)",
    "https://user@evil.com/",
    "not a url",
  ])("rejects %s", (u) => {
    expect(isAllowedDocUrl(u)).toBe(false);
  });
});
