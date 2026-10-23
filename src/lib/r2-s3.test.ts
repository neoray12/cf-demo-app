import { afterEach, describe, expect, it, vi } from "vitest";
import { s3Put } from "./r2-s3";

describe("s3Put", () => {
  afterEach(() => vi.restoreAllMocks());

  it("PUTs to the account/bucket/key URL with a SigV4 header and metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const res = await s3Put({
      accountId: "acc123",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      bucket: "my-bucket",
      key: "ws-test0001/site/index.md",
      body: new TextEncoder().encode("# hi"),
      contentType: "text/markdown",
      metadata: { sourceurl: "https://example.com/" },
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://acc123.r2.cloudflarestorage.com/my-bucket/ws-test0001/site/index.md");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-amz-meta-sourceurl"]).toBe("https://example.com/");
    expect(headers.Authorization!.startsWith("AWS4-HMAC-SHA256 ")).toBe(true);
    expect(headers.Authorization).toContain("Credential=AKID/");
    expect(headers.Authorization).toContain("x-amz-meta-sourceurl");
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("omits metadata headers when none are given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await s3Put({
      accountId: "a",
      accessKeyId: "k",
      secretAccessKey: "s",
      bucket: "b",
      key: "k.md",
      body: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
    });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(Object.keys(headers).some((h) => h.startsWith("x-amz-meta-"))).toBe(false);
  });
});
