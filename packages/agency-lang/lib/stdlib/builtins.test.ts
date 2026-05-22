import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _write } from "./builtins.js";

describe("_write mode parameter", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-write-mode-"));
    target = "out.txt";
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
  });

  it("defaults to overwrite (backward compat: no mode arg)", async () => {
    writeFileSync(join(dir, target), "existing", "utf-8");
    await _write(dir, target, "replaced");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("replaced");
  });

  it("overwrite mode replaces existing content", async () => {
    writeFileSync(join(dir, target), "existing", "utf-8");
    await _write(dir, target, "replaced", "overwrite");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("replaced");
  });

  it("append mode concatenates to existing content", async () => {
    writeFileSync(join(dir, target), "hello ", "utf-8");
    await _write(dir, target, "world", "append");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("hello world");
  });

  it("append mode creates the file when it does not exist", async () => {
    await _write(dir, target, "fresh", "append");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("fresh");
  });

  it("create-only mode creates a new file successfully", async () => {
    expect(existsSync(join(dir, target))).toBe(false);
    await _write(dir, target, "created", "create-only");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("created");
  });

  it("create-only mode throws when the file already exists", async () => {
    writeFileSync(join(dir, target), "existing", "utf-8");
    await expect(_write(dir, target, "should-fail", "create-only")).rejects.toThrow(
      /already exists/,
    );
    // Original content must be untouched.
    expect(readFileSync(join(dir, target), "utf-8")).toBe("existing");
  });

  it("rejects unknown mode strings with a clear message", async () => {
    await expect(
      _write(dir, target, "x", "bogus" as "overwrite"),
    ).rejects.toThrow(/Invalid mode 'bogus'/);
  });
});
