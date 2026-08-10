import { createHash } from "crypto";
import { describe, it, expect } from "vitest";
import { signRequest } from "./sigv4.js";

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
