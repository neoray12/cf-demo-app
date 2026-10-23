import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({
    env: {
      CF_ACCOUNT_ID: "acc",
      CF_API_TOKEN: "tok",
      KB_AI_SEARCH: "inst",
      KB_BUCKET_NAME: "kb-bucket",
      R2_ACCESS_KEY_ID: "AKID",
      R2_SECRET_ACCESS_KEY: "secret",
      KV: {
        get: async (k: string) => (kvStore.has(k) ? JSON.parse(kvStore.get(k)!) : null),
        put: async (k: string, v: string) => void kvStore.set(k, v),
      },
    },
  }),
}));

import { requireWritableWorkspace } from "./kb-route";
import { POST as upload } from "@/app/api/agents/kb/upload/route";
import { GET as importGet, POST as importPost } from "@/app/api/agents/kb/import-site/route";

const WS = "ws-test0002";
const importUrl = (qs: string) => new NextRequest(`http://localhost/api/agents/kb/import-site?${qs}`);
const importStart = (body: unknown) =>
  new NextRequest("http://localhost/api/agents/kb/import-site", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  kvStore.clear();
  vi.restoreAllMocks();
});

describe("requireWritableWorkspace", () => {
  it("rejects default as read-only and invalid ids as badWorkspace", async () => {
    const ro = requireWritableWorkspace("default") as Response;
    expect(ro.status).toBe(400);
    expect(await ro.json()).toEqual({ error: "agents.kb.errors.readOnlyWorkspace" });
    const bad = requireWritableWorkspace("../x") as Response;
    expect(await bad.json()).toEqual({ error: "agents.kb.errors.badWorkspace" });
    expect(requireWritableWorkspace(WS)).toBe(WS);
  });
});

describe("default workspace is read-only through the routes", () => {
  it("upload POST -> 400 readOnlyWorkspace without touching the network", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const form = new FormData();
    form.set("workspace", "default");
    form.set("file", new File(["hi"], "a.md"));
    const res = await upload(new NextRequest("http://localhost/api/agents/kb/upload", { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "agents.kb.errors.readOnlyWorkspace" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("import-site POST and GET -> 400 readOnlyWorkspace", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const post = await importPost(importStart({ url: "https://example.com", workspace: "default" }));
    expect(post.status).toBe(400);
    expect(await post.json()).toEqual({ error: "agents.kb.errors.readOnlyWorkspace" });
    const get = await importGet(importUrl("jobId=abc&workspace=default"));
    expect(get.status).toBe(400);
    expect(await get.json()).toEqual({ error: "agents.kb.errors.readOnlyWorkspace" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("import-site error keys", () => {
  it("returns i18n keys for bad json / url / job id", async () => {
    const badJson = await importPost(
      new NextRequest("http://localhost/api/agents/kb/import-site", { method: "POST", body: "{nope" }),
    );
    expect(await badJson.json()).toEqual({ error: "agents.kb.errors.badJson" });
    const badUrl = await importPost(importStart({ url: "ftp://x", workspace: WS }));
    expect(await badUrl.json()).toEqual({ error: "agents.kb.errors.badUrl" });
    const noJob = await importGet(importUrl(`workspace=${WS}`));
    expect(noJob.status).toBe(400);
    expect(await noJob.json()).toEqual({ error: "agents.kb.errors.missingJobId" });
  });
});

describe("import-site job binding and idempotency", () => {
  it("404 for an unknown job, 403 for another workspace's job", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const unknown = await importGet(importUrl(`jobId=nope&workspace=${WS}`));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "agents.kb.errors.unknownJob" });

    kvStore.set("kb-import:job1", JSON.stringify({ workspace: "ws-other000", url: "https://example.com/", status: "running" }));
    const wrong = await importGet(importUrl(`jobId=job1&workspace=${WS}`));
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "agents.kb.errors.wrongWorkspace" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes pages under site/{hostSlug}/ once; a repeat poll returns the stored result without writing or syncing", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/browser-rendering/crawl")) return Response.json({ success: true, result: "job-1" });
      if (url.includes("/browser-rendering/crawl/job-1")) {
        return Response.json({
          success: true,
          result: {
            status: "completed",
            finished: 2,
            total: 3,
            records: [
              { url: "https://example.com/", status: "completed", markdown: "# Home" },
              { url: "https://example.com/about", status: "completed", markdown: "# About" },
              { url: "https://example.com/broken", status: "errored" },
            ],
          },
        });
      }
      if (url.includes("r2.cloudflarestorage.com")) return new Response(null, { status: 200 });
      if (url.endsWith("/jobs")) return Response.json({ success: true, result: { id: "sync-1" } });
      throw new Error(`unexpected fetch ${url}`);
    });

    const start = await importPost(importStart({ url: "https://example.com", workspace: WS }));
    expect(await start.json()).toEqual({ jobId: "job-1" });
    expect(JSON.parse(kvStore.get("kb-import:job-1")!)).toMatchObject({ workspace: WS, status: "running" });

    const first = await importGet(importUrl(`jobId=job-1&workspace=${WS}`));
    expect(await first.json()).toEqual({ status: "completed", saved: 2, failed: 1, indexJobId: "sync-1" });
    const puts = calls.filter((c) => c.method === "PUT").map((c) => c.url);
    expect(puts).toEqual([
      `https://acc.r2.cloudflarestorage.com/kb-bucket/${WS}/site/example-com/index.md`,
      `https://acc.r2.cloudflarestorage.com/kb-bucket/${WS}/site/example-com/about.md`,
    ]);
    expect(JSON.parse(kvStore.get("kb-import:job-1")!)).toMatchObject({ status: "completed", saved: 2, failed: 1 });

    const before = calls.length;
    const again = await importGet(importUrl(`jobId=job-1&workspace=${WS}`));
    expect(await again.json()).toEqual({ status: "completed", saved: 2, failed: 1, indexJobId: "sync-1" });
    expect(calls.length).toBe(before);
  });

  it("does not write again while another poll holds the writing marker", async () => {
    kvStore.set(
      "kb-import:job-2",
      JSON.stringify({ workspace: WS, url: "https://example.com/", status: "writing", writingAt: Date.now() }),
    );
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Response.json({ success: true, result: { status: "completed", finished: 1, total: 1 } });
    });
    const res = await importGet(importUrl(`jobId=job-2&workspace=${WS}`));
    expect(await res.json()).toMatchObject({ status: "running" });
    expect(calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
  });
});
