import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeObjectPath, presignPut, presignV4, s3Put } from "./r2-s3";

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

describe("presignV4", () => {
  it("matches the AWS SigV4 query-auth documentation example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const { url } = await presignV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});

describe("presignPut", () => {
  const NOW = new Date("2026-10-24T01:02:03.456Z");
  const base = {
    accountId: "acc123",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    bucket: "cf-demo-kb",
    contentType: "application/pdf",
    contentLength: 65536,
    now: NOW,
  };

  it("builds an R2 URL with the expected query parameters and signed headers", async () => {
    const url = new URL(await presignPut({ ...base, key: "ws-abcd1234/report.pdf" }));
    expect(url.origin).toBe("https://acc123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/cf-demo-kb/ws-abcd1234/report.pdf");
    const q = Object.fromEntries(url.searchParams);
    expect(q).toEqual({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
      "X-Amz-Credential": "AKID/20261024/auto/s3/aws4_request",
      "X-Amz-Date": "20261024T010203Z",
      "X-Amz-Expires": "300",
      "X-Amz-SignedHeaders": "content-length;content-type;host",
      "X-Amz-Signature": expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("signs a canonical request that an independent SigV4 implementation agrees with", async () => {
    const key = "ws-abcd1234/季報 (v2).pdf";
    const url = await presignPut({ ...base, key, expiresSeconds: 120 });
    const path = "/cf-demo-kb/ws-abcd1234/%E5%AD%A3%E5%A0%B1%20%28v2%29.pdf";
    expect(encodeObjectPath("cf-demo-kb", key)).toBe(path);
    expect(url.startsWith(`https://acc123.r2.cloudflarestorage.com${path}?`)).toBe(true);

    const query =
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD" +
      "&X-Amz-Credential=AKID%2F20261024%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261024T010203Z" +
      "&X-Amz-Expires=120&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost";
    const canonical = [
      "PUT",
      path,
      query,
      "content-length:65536\ncontent-type:application/pdf\nhost:acc123.r2.cloudflarestorage.com\n",
      "content-length;content-type;host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const toSign = [
      "AWS4-HMAC-SHA256",
      "20261024T010203Z",
      "20261024/auto/s3/aws4_request",
      createHash("sha256").update(canonical).digest("hex"),
    ].join("\n");
    const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
    const signingKey = hmac(hmac(hmac(hmac("AWS4secret", "20261024"), "auto"), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
    expect(url).toBe(`https://acc123.r2.cloudflarestorage.com${path}?${query}&X-Amz-Signature=${signature}`);
  });

  it("changes the signature when the declared type or size changes", async () => {
    const sig = async (o: Partial<typeof base>) =>
      new URL(await presignPut({ ...base, ...o, key: "ws-abcd1234/a.pdf" })).searchParams.get("X-Amz-Signature");
    const a = await sig({});
    expect(await sig({})).toBe(a);
    expect(await sig({ contentLength: 65537 })).not.toBe(a);
    expect(await sig({ contentType: "text/plain" })).not.toBe(a);
  });
});
