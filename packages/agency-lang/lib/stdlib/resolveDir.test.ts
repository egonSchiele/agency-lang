import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDir } from "./resolveDir.js";

describe("resolveDir", () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resolvedir-"));
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("expands ~ to the home directory", async () => {
    // Use the inside-home/no-op-allowedPaths case so the test doesn't
    // depend on any path inside $HOME existing.
    const result = await resolveDir("~");
    expect(result).toBe(os.homedir());
  });

  it("expands ~/sub to homedir/sub without requiring it to exist", async () => {
    const result = await resolveDir("~/some-nonexistent-subdir-xyz");
    expect(result).toBe(path.join(os.homedir(), "some-nonexistent-subdir-xyz"));
  });

  it("resolves a relative non-tilde path against the module dir (default)", async () => {
    // Outside an Agency frame, getModuleDir() falls back to process.cwd();
    // tmpRoot IS the cwd because of beforeEach. Confirm relative paths
    // anchor there (NOT $HOME). `resolveDir` does NOT pre-create the
    // dir (unlike normalizeMemoryFrame); callers that need it created
    // do that themselves. So we compare lexically against realpath of
    // the existing tmpRoot.
    const result = await resolveDir("./sub");
    expect(result).toBe(path.join(fs.realpathSync(tmpRoot), "sub"));
    expect(result).not.toContain(os.homedir());
  });

  it("resolves against cwd explicitly when base=\"cwd\"", async () => {
    const result = await resolveDir("./cwd-anchored", [], "cwd");
    expect(result).toBe(path.join(fs.realpathSync(tmpRoot), "cwd-anchored"));
  });

  it("accepts an allow-list and validates containment", async () => {
    const allowed = path.join(tmpRoot, "allowed-root");
    fs.mkdirSync(allowed, { recursive: true });
    const target = path.join("allowed-root", "inside");
    const result = await resolveDir(target, [allowed]);
    expect(result.startsWith(fs.realpathSync(allowed))).toBe(true);
  });

  it("throws when the resolved path is outside the allow-list", async () => {
    const allowed = path.join(tmpRoot, "allowed-root");
    fs.mkdirSync(allowed, { recursive: true });
    await expect(
      resolveDir(path.join(tmpRoot, "outside"), [allowed]),
    ).rejects.toThrow(/not under/);
  });
});
