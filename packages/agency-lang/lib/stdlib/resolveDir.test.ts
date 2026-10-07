import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDir, resolveCwdPath } from "./resolveDir.js";
import { nodeHost } from "../host/node/nodeHost.js";
import { withRun } from "../runtime/asyncContext.js";

describe("resolveDir", () => {
  const host = nodeHost();
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
    const result = await resolveDir(host, "~");
    expect(result).toBe(os.homedir());
  });

  it("expands ~/sub to homedir/sub without requiring it to exist", async () => {
    const result = await resolveDir(host, "~/some-nonexistent-subdir-xyz");
    expect(result).toBe(path.join(os.homedir(), "some-nonexistent-subdir-xyz"));
  });

  it("resolves a relative non-tilde path against the cwd", async () => {
    // tmpRoot IS the cwd because of beforeEach. `resolveDir` does NOT
    // pre-create the dir; callers that need it created do that
    // themselves. So we compare lexically against realpath of the
    // existing tmpRoot.
    const result = await resolveDir(host, "./sub");
    expect(result).toBe(path.join(fs.realpathSync(tmpRoot), "sub"));
    expect(result).not.toContain(os.homedir());
  });

  it("accepts an allow-list and validates containment", async () => {
    const allowed = path.join(tmpRoot, "allowed-root");
    fs.mkdirSync(allowed, { recursive: true });
    const target = path.join("allowed-root", "inside");
    const result = await resolveDir(host, target, [allowed]);
    expect(result.startsWith(fs.realpathSync(allowed))).toBe(true);
  });

  it("throws when the resolved path is outside the allow-list", async () => {
    const allowed = path.join(tmpRoot, "allowed-root");
    fs.mkdirSync(allowed, { recursive: true });
    await expect(resolveDir(host, path.join(tmpRoot, "outside"), [allowed])).rejects.toThrow(
      /not under/,
    );
  });

  it("stays cwd-anchored under a run", async () => {
    const result = await withRun(
      {
        ctx: {},
        stack: {},
        threads: {},
      } as any,
      () => resolveDir(host, "./prompts"),
    );
    expect(result).toBe(path.join(fs.realpathSync(tmpRoot), "prompts"));
  });

  it("validates tilde-in-target against a tilde-in-allowlist (cross product)", async () => {
    // Exercises that expansion is applied symmetrically: both target
    // and allowlist entries reach `assertContained` already expanded.
    const result = await resolveDir(host, "~/sandbox/work", ["~/sandbox"]);
    expect(result).toBe(path.join(os.homedir(), "sandbox", "work"));
  });
});

describe("resolveCwdPath", () => {
  const host = nodeHost();

  it("resolves a relative path against the cwd", () => {
    expect(resolveCwdPath(host, "a/b.txt")).toBe(path.resolve(process.cwd(), "a/b.txt"));
  });

  it("expands ~", () => {
    expect(resolveCwdPath(host, "~/x.md")).toBe(path.join(os.homedir(), "x.md"));
  });

  it("passes absolute paths through", () => {
    expect(resolveCwdPath(host, "/tmp/x")).toBe(path.resolve("/tmp/x"));
  });
});
