import { describe, it, expect } from "vitest";
import {
  decodeBase64Strict,
  encodeBase64,
  encodeBase64Text,
  encodeBase64Url,
  utf8ByteLength,
} from "./base64.js";

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
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (i * 7919) % 256;
    }
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(decodeBase64Strict(encodeBase64(bytes))).toEqual(bytes);
  });

  it("decodes what Buffer decodes, byte for byte", () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (i * 7919) % 256;
    }
    const text = Buffer.from(bytes).toString("base64");
    expect(decodeBase64Strict(text)).toEqual(new Uint8Array(Buffer.from(text, "base64")));
  });
});

describe("encodeBase64Url", () => {
  it("matches Buffer's base64url for every length of padding and bytes that need the other alphabet", () => {
    const samples = ["", "f", "fo", "foo", "foob", "fooba", "foobar"];
    for (const sample of samples) {
      const bytes = new TextEncoder().encode(sample);
      expect(encodeBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0xfe, 0x3e, 0x3f]);
    expect(encodeBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
  });
});

describe("utf8ByteLength", () => {
  it("counts bytes the way Buffer.byteLength does", () => {
    for (const sample of ["", "a", "héllo", "日本語", "😀"]) {
      expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, "utf8"));
    }
  });
});
