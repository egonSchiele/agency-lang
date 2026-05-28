import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { assertContained } from "./assertContained.js";

describe("assertContained", () => {
  let tmpRoot: string;
  let allowed: string;
  let outside: string;
  let symlinkInside: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assertContained-"));
    allowed = path.join(tmpRoot, "allowed");
    outside = path.join(tmpRoot, "outside");
    symlinkInside = path.join(allowed, "escape");
    await fs.mkdir(allowed, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(allowed, "ok.txt"), "ok");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, symlinkInside);
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("is a no-op when allowedRoots is empty", async () => {
    await expect(
      assertContained("/anywhere/at/all", []),
    ).resolves.toBeUndefined();
  });

  it("accepts a target equal to the root", async () => {
    await expect(assertContained(allowed, [allowed])).resolves.toBeUndefined();
  });

  it("accepts a target inside the root", async () => {
    await expect(
      assertContained(path.join(allowed, "ok.txt"), [allowed]),
    ).resolves.toBeUndefined();
  });

  it("rejects a target outside the root", async () => {
    await expect(
      assertContained(path.join(outside, "secret.txt"), [allowed]),
    ).rejects.toThrow(/is not under any of the allowed paths/);
  });

  it("rejects a non-existent target outside the root", async () => {
    await expect(
      assertContained(path.join(outside, "missing.txt"), [allowed]),
    ).rejects.toThrow(/is not under any of the allowed paths/);
  });

  it("accepts a non-existent target inside the root", async () => {
    await expect(
      assertContained(path.join(allowed, "new-file.txt"), [allowed]),
    ).resolves.toBeUndefined();
  });

  it("rejects a target reached through a symlink that escapes the root", async () => {
    // `symlinkInside` lives lexically inside `allowed/` but resolves to
    // `outside/`. Accessing `outside/secret.txt` via `allowed/escape/secret.txt`
    // must be rejected by the realpath check.
    await expect(
      assertContained(
        path.join(symlinkInside, "secret.txt"),
        [allowed],
      ),
    ).rejects.toThrow(/is not under any of the allowed paths/);
  });

  it("accepts a target under any one of multiple roots", async () => {
    const otherRoot = path.join(tmpRoot, "other");
    await fs.mkdir(otherRoot, { recursive: true });
    await fs.writeFile(path.join(otherRoot, "file.txt"), "x");
    await expect(
      assertContained(path.join(otherRoot, "file.txt"), [allowed, otherRoot]),
    ).resolves.toBeUndefined();
  });

  it("rejects an empty target with a non-empty root list", async () => {
    await expect(assertContained("", [allowed])).rejects.toThrow(
      /must not be empty/,
    );
  });

  it("ignores empty strings inside allowedRoots", async () => {
    // An empty string in `allowedRoots` would otherwise resolve to cwd,
    // accidentally allowing way too much. We skip empties instead.
    await expect(
      assertContained(path.join(outside, "secret.txt"), ["", allowed]),
    ).rejects.toThrow(/is not under any of the allowed paths/);
  });
});
