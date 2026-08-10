import { createHash } from "crypto";
import { describe, it, expect } from "vitest";
import { presignRequest, signRequest } from "./sigv4.js";
import { createAwsRequestTarget } from "./client.js";

const base = {
  region: "us-east-1",
  service: "s3",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  date: new Date("2013-05-24T00:00:00.000Z"),
};

describe("signRequest", () => {
  it("reproduces AWS's published S3 GET test-vector signature", () => {
    const headers = signRequest({
      ...base,
      method: "GET",
      wireUrl: "https://examplebucket.s3.amazonaws.com/test.txt",
      canonicalUri: "/test.txt",
      extraHeaders: { range: "bytes=0-9" },
    });
    expect(headers.Authorization).toContain(
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("hashes raw binary bytes for the content hash", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const headers = signRequest({
      ...base,
      method: "PUT",
      wireUrl: "https://b.s3.us-east-1.amazonaws.com/k",
      canonicalUri: "/k",
      body: bytes,
    });
    expect(headers["x-amz-content-sha256"]).toBe(expected);
  });

  it("signs the session token header when present", () => {
    const headers = signRequest({
      ...base,
      method: "GET",
      wireUrl: "https://b.s3.us-east-1.amazonaws.com/k",
      canonicalUri: "/k",
      sessionToken: "TOKEN",
    });
    expect(headers["x-amz-security-token"]).toBe("TOKEN");
    expect(headers.Authorization).toContain("x-amz-security-token");
  });
});

describe("presignRequest", () => {
  it("reproduces AWS's published presigned-GET test-vector URL exactly", () => {
    const url = presignRequest({
      ...base,
      method: "GET",
      target: createAwsRequestTarget("https://examplebucket.s3.amazonaws.com", "/test.txt"),
      expiresIn: 86400000, // 1 day in ms; AWS's vector signs X-Amz-Expires=86400 seconds
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z" +
        "&X-Amz-Expires=86400" +
        "&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("signs the session token in the query, sorted before X-Amz-SignedHeaders", () => {
    const url = presignRequest({
      ...base,
      method: "GET",
      target: createAwsRequestTarget("https://b.s3.us-east-1.amazonaws.com", "/k"),
      sessionToken: "TOKEN",
      expiresIn: 3600000,
    });
    expect(url).toContain(
      "&X-Amz-Security-Token=TOKEN&X-Amz-SignedHeaders=host&X-Amz-Signature=",
    );
  });

  it("rounds a sub-second millisecond remainder UP to whole seconds", () => {
    // X-Amz-Expires must be an integer; 1500ms must sign as 2s, never 1.5 or 1.
    const url = presignRequest({
      ...base,
      method: "GET",
      target: createAwsRequestTarget("https://b.s3.us-east-1.amazonaws.com", "/k"),
      expiresIn: 1500,
    });
    expect(url).toContain("&X-Amz-Expires=2&");
  });

  // The AWS vector's key is the trivial `test.txt`; this case pins the
  // one-encoding contract — the emitted path and query are byte-for-byte the
  // strings that were signed, with no second encoding or normalization.
  it("emits hostile key and token characters exactly as signed", () => {
    const url = presignRequest({
      ...base,
      method: "GET",
      // key "a b/%雪//c", encoded once by the endpoint builder's convention
      target: createAwsRequestTarget(
        "https://examplebucket.s3.amazonaws.com",
        "/a%20b/%25%E9%9B%AA//c",
      ),
      sessionToken: "AB+/= x",
      expiresIn: 3600000,
    });
    const [prefix, signature] = url.split("&X-Amz-Signature=");
    expect(prefix).toBe(
      "https://examplebucket.s3.amazonaws.com/a%20b/%25%E9%9B%AA//c" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z" +
        "&X-Amz-Expires=3600" +
        "&X-Amz-Security-Token=AB%2B%2F%3D%20x" +
        "&X-Amz-SignedHeaders=host",
    );
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});
