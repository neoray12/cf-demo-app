import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import zhTW from "../../../i18n/zh-TW.json";
import en from "../../../i18n/en.json";
import type { EgressEvent } from "@/lib/sandbox-egress";
import { EgressLog } from "./egress-log";

const EVENTS: EgressEvent[] = [
  { at: 1, method: "GET", host: "pypi.org", path: "/simple/requests/", action: "allowed", status: 200 },
  { at: 2, method: "GET", host: "api.github.com", path: "/rate_limit", action: "injected", status: 200 },
  { at: 3, method: "POST", host: "exfil.example.net", path: "/collect", action: "blocked", status: 403 },
];

const render = (events: EgressEvent[] | undefined) => renderToStaticMarkup(createElement(EgressLog, { events }));

describe("EgressLog", () => {
  it("renders one row per egress decision with host, path and status", () => {
    const html = render(EVENTS);
    for (const e of EVENTS) {
      expect(html).toContain(e.host);
      expect(html).toContain(e.path);
    }
    expect(html.match(/data-egress-action=/g)).toHaveLength(3);
    expect(html).toContain('data-egress-action="injected"');
    expect(html).toContain('data-egress-action="blocked"');
    expect(html).toContain("403");
  });

  it("renders nothing without events", () => {
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });
});

describe("egress i18n", () => {
  it("has the egress log and example strings in both languages", () => {
    for (const lang of [zhTW, en] as unknown as Array<{ chat: Record<string, Record<string, unknown>> }>) {
      const egress = lang.chat.egress as Record<string, string>;
      for (const key of ["title", "allowed", "injected", "blocked", "tooltip"]) expect(egress?.[key], key).toBeTruthy();
      const s = lang.chat.sandboxSuggestions as Record<string, { title?: string; prompt?: string }>;
      for (const key of ["githubToken", "exfil", "pipInstall"]) {
        expect(s[key]?.title, key).toBeTruthy();
        expect(s[key]?.prompt, key).toBeTruthy();
      }
    }
  });
});
