import { describe, it, expect } from "vitest";
import { decodeBase64Strict, encodeBase64, encodeBase64Text } from "./base64.js";

describe("decodeBase64Strict", () => {
  it("decodes valid base64", () => {
    expect(Array.from(decodeBase64Strict("aGk="))).toEqual([104, 105]); // "hi"
  });
  it("ignores whitespace", () => {
    expect(Array.from(decodeBase64Strict("aG\n k="))).toEqual([104, 105]);
  });
  it.each(["aGk", "aG*=", "a===", "!!!!", "=aGk"])("throws on invalid input %s", (bad) => {
    expect(() => decodeBase64Strict(bad)).toThrow(/base64/);
  });
});

describe("encodeBase64", () => {
  it("matches Buffer for every length of padding and a run of bytes", () => {
    const samples = ["", "f", "fo", "foo", "foob", "fooba", "foobar", "api:key-123"];
    for (const sample of samples) {
      expect(encodeBase64Text(sample)).toBe(Buffer.from(sample).toString("base64"));
    }
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) % 256;
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(decodeBase64Strict(encodeBase64(bytes))).toEqual(bytes);
  });
});
