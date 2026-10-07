import { describe, it, expect, afterEach } from "vitest";
import crypto from "crypto";
import { encrypt, decrypt, getEncryptionKey } from "../oauthEncryption.js";
import { memoryHost } from "../../host/memoryHost.js";

describe("getEncryptionKey", () => {
  const originalKey = process.env.AGENCY_OAUTH_KEY;
  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.AGENCY_OAUTH_KEY;
    } else {
      process.env.AGENCY_OAUTH_KEY = originalKey;
    }
  });

  it("hashes AGENCY_OAUTH_KEY without touching the host", async () => {
    process.env.AGENCY_OAUTH_KEY = "pass";
    const key = await getEncryptionKey(memoryHost({ capabilities: [] }));
    expect(key).toEqual(crypto.createHash("sha256").update("pass").digest());
  });

  it("reads the keyring through the given host, so a host without subprocesses has no key", async () => {
    delete process.env.AGENCY_OAUTH_KEY;
    // The memory host runs no programs, so the keyring is unavailable
    // there whatever this machine has. Nothing reaches the real keyring.
    expect(await getEncryptionKey(memoryHost())).toBeNull();
  });
});

describe("encrypt/decrypt", () => {
  const key = crypto.randomBytes(32);

  it("round-trips plaintext through encrypt then decrypt", () => {
    const plaintext = JSON.stringify({ access_token: "abc", secret: "xyz" });
    const ciphertext = encrypt(plaintext, key);
    const result = decrypt(ciphertext, key);
    expect(result).toBe(plaintext);
  });

  it("produces different ciphertext for same plaintext (random IV)", () => {
    const plaintext = "hello world";
    const c1 = encrypt(plaintext, key);
    const c2 = encrypt(plaintext, key);
    expect(c1).not.toBe(c2);
  });

  it("ciphertext is base64 encoded", () => {
    const ciphertext = encrypt("test", key);
    expect(() => Buffer.from(ciphertext, "base64")).not.toThrow();
    // Re-encoding should match (valid base64)
    expect(Buffer.from(ciphertext, "base64").toString("base64")).toBe(ciphertext);
  });

  it("throws on tampered ciphertext", () => {
    const ciphertext = encrypt("secret data", key);
    const buf = Buffer.from(ciphertext, "base64");
    buf[buf.length - 1] ^= 0xff; // flip last byte
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("throws with wrong key", () => {
    const ciphertext = encrypt("secret", key);
    const wrongKey = crypto.randomBytes(32);
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });

  it("throws on too-short input", () => {
    const short = Buffer.from("too short").toString("base64");
    expect(() => decrypt(short, key)).toThrow("too short");
  });

  it("handles empty string plaintext", () => {
    const ciphertext = encrypt("", key);
    expect(decrypt(ciphertext, key)).toBe("");
  });

  it("handles unicode content", () => {
    const plaintext = "Hello 🌍 café résumé 日本語";
    const ciphertext = encrypt(plaintext, key);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });
});
