import { describe, it, expect } from "vitest";
import { createHash, createHmac, randomBytes } from "crypto";
import { sha256Bytes, sha256Hex, sha256Text, hmacSha256, toHex } from "./hash.js";

// Node's crypto is the reference. These tests exist so the portable
// implementation can never drift from it.
function referenceSha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function referenceHmac(key: Uint8Array | string, data: Uint8Array | string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

describe("sha256", () => {
  it("hashes the empty input", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the FIPS 180-4 test vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes UTF-8 text the way Node does", () => {
    const text = "héllo wörld — 日本語";
    expect(sha256Text(text)).toBe(referenceSha256(text));
  });

  // The padding takes one block when the remainder leaves 9 or more bytes
  // free, and two blocks otherwise. Every length from 0 to 130 crosses both
  // boundaries more than once.
  it("pads every length from 0 to 130 bytes correctly", () => {
    for (let length = 0; length <= 130; length++) {
      const data = randomBytes(length);
      expect(sha256Hex(new Uint8Array(data))).toBe(referenceSha256(data));
    }
  });

  it("hashes a megabyte of random bytes", () => {
    const data = randomBytes(1024 * 1024);
    expect(toHex(sha256Bytes(new Uint8Array(data)))).toBe(referenceSha256(data));
  });
});

describe("hmacSha256", () => {
  it("matches the RFC 4231 test case 2", () => {
    expect(toHex(hmacSha256("Jefe", "what do ya want for nothing?"))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("hashes a key longer than one block first", () => {
    const key = randomBytes(100);
    const data = "signed";
    expect(toHex(hmacSha256(new Uint8Array(key), data))).toBe(referenceHmac(key, data));
  });

  it("matches Node for random keys and data", () => {
    for (let round = 0; round < 20; round++) {
      const key = randomBytes(1 + round * 7);
      const data = randomBytes(round * 13);
      expect(toHex(hmacSha256(new Uint8Array(key), new Uint8Array(data)))).toBe(
        referenceHmac(key, data),
      );
    }
  });
});
