import { describe, expect, it } from "vitest";
import { AGENT_CATALOG, AGENT_TOOL_LABEL_KEYS, AGENTS_DASHBOARD_URL } from "./catalog";
import { AGENT_IDS } from "./ids";
import { AGENT_MODELS } from "./models";
import agentsZh from "@/i18n/agents.zh-TW.json";
import agentsEn from "@/i18n/agents.en.json";

type Tree = { [key: string]: unknown };

/**
 * Resolve a dot path the way i18next does: segments may themselves contain dots
 * (e.g. `agents.models.kimi-k2.6`), so try progressively longer segment joins.
 */
function lookup(tree: unknown, path: string): unknown {
  const parts = path.split(".");
  const walk = (node: unknown, i: number): unknown => {
    if (i === parts.length) return node;
    if (node === null || typeof node !== "object") return undefined;
    for (let j = i + 1; j <= parts.length; j++) {
      const key = parts.slice(i, j).join(".");
      if (Object.hasOwn(node as Tree, key)) {
        const hit = walk((node as Tree)[key], j);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(tree, 0);
}

const catalogs = { "zh-TW": agentsZh, en: agentsEn } as const;

function allKeys(): string[] {
  const keys = ["agents.nav.title"];
  for (const a of AGENT_CATALOG) keys.push(a.navKey, a.titleKey, a.descKey, ...a.suggestionKeys);
  for (const m of Object.values(AGENT_MODELS)) keys.push(m.labelKey);
  keys.push(...Object.values(AGENT_TOOL_LABEL_KEYS));
  for (const k of [
    "badJson",
    "missingJobId",
    "badWorkspace",
    "readOnlyWorkspace",
    "noFile",
    "badName",
    "badUrl",
    "badType",
    "tooLarge",
    "tooMany",
    "unknownJob",
    "wrongWorkspace",
    "server",
  ]) {
    keys.push(`agents.kb.errors.${k}`);
  }
  return keys;
}

describe("AGENT_CATALOG", () => {
  it("lists exactly the registered agents, in AGENT_IDS order", () => {
    expect(AGENT_CATALOG.map((a) => a.id)).toEqual([...AGENT_IDS]);
  });

  it("uses /agents/<id> paths and the spec's default model", () => {
    for (const a of AGENT_CATALOG) {
      expect(a.path).toBe(`/agents/${a.id}`);
      expect(a.defaultModel).toBe("kimi-k2.6");
      expect(a.suggestionKeys.length).toBeGreaterThan(0);
    }
  });

  it("points the dashboard link at the Agents tab of the Neo-Cloudflare account", () => {
    expect(AGENTS_DASHBOARD_URL).toBe("https://dash.cloudflare.com/5efa272dc28e4e3933324c44165b6dbe/agents");
  });

  it("keeps every agents.* key inside a single top-level `agents` object", () => {
    expect(Object.keys(agentsZh)).toEqual(["agents"]);
    expect(Object.keys(agentsEn)).toEqual(["agents"]);
  });

  for (const [lang, tree] of Object.entries(catalogs)) {
    it(`has every referenced key as a non-empty string in agents.${lang}.json`, () => {
      const missing = allKeys().filter((k) => {
        const v = lookup(tree, k);
        return typeof v !== "string" || v.trim() === "";
      });
      expect(missing).toEqual([]);
    });
  }

  it("has the same key set in both languages", () => {
    const flatten = (node: unknown, prefix = ""): string[] =>
      node !== null && typeof node === "object"
        ? Object.entries(node as Tree).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
        : [prefix];
    expect(flatten(agentsEn).sort()).toEqual(flatten(agentsZh).sort());
  });
});
