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
import { POST as presign } from "@/app/api/agents/kb/upload/presign/route";
import { POST as complete } from "@/app/api/agents/kb/upload/complete/route";
import { GET as status } from "@/app/api/agents/kb/status/route";
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

const jsonReq = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("direct upload: presign", () => {
  it("validates like the multipart route and returns a presigned R2 URL with the server-chosen type", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/r2/buckets/kb-bucket/objects")) {
        return Response.json({ success: true, result: [{ key: `${WS}/report.pdf`, size: 1 }], result_info: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const res = await presign(
      jsonReq("/api/agents/kb/upload/presign", { workspace: WS, name: "report.pdf", size: 65536, type: "text/html" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; url: string; headers: Record<string, string> };
    expect(body.key).toMatch(new RegExp(`^${WS}/report-[0-9a-f]{4}\\.pdf$`));
    expect(body.headers).toEqual({ "content-type": "application/pdf" });
    const u = new URL(body.url);
    expect(u.origin).toBe("https://acc.r2.cloudflarestorage.com");
    expect(u.pathname).toBe(`/kb-bucket/${body.key}`);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });

  it("returns i18n keys for read-only workspace, bad type, too large and too many", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: true, result: Array.from({ length: 20 }, (_, i) => ({ key: `${WS}/f${i}.md`, size: 1 })) }),
    );
    const ro = await presign(jsonReq("/x", { workspace: "default", name: "a.pdf", size: 1 }));
    expect(await ro.json()).toEqual({ error: "agents.kb.errors.readOnlyWorkspace" });
    expect(fetchMock).not.toHaveBeenCalled();
    const badType = await presign(jsonReq("/x", { workspace: WS, name: "a.exe", size: 1 }));
    expect(await badType.json()).toEqual({ error: "agents.kb.errors.badType" });
    const big = await presign(jsonReq("/x", { workspace: WS, name: "a.pdf", size: 10 * 1024 * 1024 + 1 }));
    expect(await big.json()).toEqual({ error: "agents.kb.errors.tooLarge" });
    const many = await presign(jsonReq("/x", { workspace: WS, name: "a.pdf", size: 10 }));
    expect(await many.json()).toEqual({ error: "agents.kb.errors.tooMany" });
    const noSize = await presign(jsonReq("/x", { workspace: WS, name: "a.pdf" }));
    expect(await noSize.json()).toEqual({ error: "agents.kb.errors.noFile" });
  });
});

describe("direct upload: complete", () => {
  it("rejects keys outside the workspace, under site/ or with ..", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const key of ["ws-other000/a.pdf", `${WS}/site/a.md`, `${WS}/../x.pdf`]) {
      const res = await complete(jsonReq("/x", { workspace: WS, key }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "agents.kb.errors.badKey" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 notUploaded when the object is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, result: [{ key: `${WS}/a.pdf.bak`, size: 3 }] }));
    const res = await complete(jsonReq("/x", { workspace: WS, key: `${WS}/a.pdf` }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "agents.kb.errors.notUploaded" });
  });

  it("verifies the object, triggers a sync and reports cooldown as syncPending", async () => {
    let cooldown = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/objects?")) return Response.json({ success: true, result: [{ key: `${WS}/a.pdf`, size: 65536 }] });
      if (url.endsWith("/jobs")) {
        return cooldown
          ? Response.json({ success: false, errors: [{ code: 7020, message: "sync_in_cooldown" }] }, { status: 429 })
          : Response.json({ success: true, result: { id: "sync-9" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const ok = await complete(jsonReq("/x", { workspace: WS, key: `${WS}/a.pdf` }));
    expect(await ok.json()).toEqual({ key: `${WS}/a.pdf`, size: 65536, indexJobId: "sync-9", syncPending: false });
    expect(kvStore.has(`kb-sync-attempt:${WS}`)).toBe(true);
    cooldown = true;
    const cd = await complete(jsonReq("/x", { workspace: WS, key: `${WS}/a.pdf` }));
    expect(await cd.json()).toEqual({ key: `${WS}/a.pdf`, size: 65536, indexJobId: null, syncPending: true });
  });
});

describe("status sync retry", () => {
  const mockApis = (items: Array<{ key: string; status: string }>) => {
    const jobs: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/instances/inst")) return Response.json({ success: true, result: { status: "ready", last_activity: null } });
      if (url.includes("/items?")) return Response.json({ success: true, result: items });
      if (url.includes("/objects?")) return Response.json({ success: true, result: [{ key: `${WS}/a.pdf`, size: 1 }], result_info: null });
      if (url.endsWith("/jobs")) {
        jobs.push(url);
        return Response.json({ success: true, result: { id: "j" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    return jobs;
  };
  const get = (ws: string) => status(new NextRequest(`http://localhost/api/agents/kb/status?workspace=${ws}`));

  it("re-triggers a sync for an unindexed upload, then waits 60 s before the next attempt", async () => {
    const jobs = mockApis([]);
    const first = await (await get(WS)).json();
    expect(first).toMatchObject({ status: "ready", files: [], syncPending: true, syncTriggered: true });
    const second = await (await get(WS)).json();
    expect(second).toMatchObject({ syncPending: true, syncTriggered: false });
    expect(jobs).toHaveLength(1);
  });

  it("does not sync when everything is completed, nor for the default workspace", async () => {
    const jobs = mockApis([{ key: `${WS}/a.pdf`, status: "completed" }]);
    expect(await (await get(WS)).json()).toMatchObject({ syncPending: false, syncTriggered: false });
    expect(await (await get("default")).json()).toMatchObject({ syncPending: false, syncTriggered: false });
    expect(jobs).toHaveLength(0);
  });
});
