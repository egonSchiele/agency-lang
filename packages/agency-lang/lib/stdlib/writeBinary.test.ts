import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { _writeBinary, _readBinary } from "./builtins.js";

describe("_writeBinary", () => {
  it("writes the exact decoded bytes (round-trips via _readBinary)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-"));
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG magic
    const b64 = original.toString("base64");
    await _writeBinary(dir, "out.bin", b64, "overwrite");
    expect(await _readBinary(dir, "out.bin")).toBe(b64);
  });

  it("create-only throws if the file exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-"));
    const b64 = Buffer.from("hi").toString("base64");
    await _writeBinary(dir, "f.bin", b64, "overwrite");
    await expect(_writeBinary(dir, "f.bin", b64, "create-only")).rejects.toThrow(
      /already exists/,
    );
  });

  it("append mode concatenates rather than overwriting", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-"));
    await _writeBinary(dir, "a.bin", Buffer.from([1, 2]).toString("base64"), "overwrite");
    await _writeBinary(dir, "a.bin", Buffer.from([3, 4]).toString("base64"), "append");
    expect(await _readBinary(dir, "a.bin")).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
  });

  it("rejects an invalid mode", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-"));
    await expect(
      _writeBinary(dir, "x.bin", "AA==", "clobber" as never),
    ).rejects.toThrow(/Invalid mode/);
  });

  it("throws on malformed base64 rather than writing corrupted bytes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-"));
    await expect(_writeBinary(dir, "bad.bin", "not valid base64!!", "overwrite")).rejects.toThrow(
      /valid base64/,
    );
  });

  it("tolerates whitespace/newlines in base64 input", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-"));
    const raw = Buffer.from([10, 20, 30, 40, 50]);
    const chunked = raw.toString("base64").replace(/(.{2})/g, "$1\n"); // inject newlines
    await _writeBinary(dir, "ws.bin", chunked, "overwrite");
    expect(await _readBinary(dir, "ws.bin")).toBe(raw.toString("base64"));
  });

  it("preserves all 256 byte values (no text-mode encoding sneaks in)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-"));
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await _writeBinary(dir, "all.bin", all.toString("base64"), "overwrite");
    expect(await _readBinary(dir, "all.bin")).toBe(all.toString("base64"));
  });
});
