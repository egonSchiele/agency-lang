import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryFrame } from "./frame.js";
import { nodeHost } from "../../host/node/nodeHost.js";

const host = nodeHost();

describe("MemoryFrame", () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memframe-"));
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves a relative dir against the working directory, in its real spelling", () => {
    const frame = new MemoryFrame({ dir: "./relmem" }, host);
    // realpath canonicalizes the tmp root too (on macOS /tmp -> /private/tmp).
    expect(frame.configKey).toBe(path.join(fs.realpathSync(tmpRoot), "relmem"));
    // The store makes the directory on its first write, not the frame.
    expect(fs.existsSync(frame.configKey)).toBe(false);
  });

  it("does not re-resolve an already-absolute dir against cwd", () => {
    const absoluteDir = path.join(tmpRoot, "absmem");
    fs.mkdirSync(absoluteDir);
    const frame = new MemoryFrame({ dir: absoluteDir }, host);
    expect(frame.configKey).toBe(fs.realpathSync(absoluteDir));
  });

  it("spells a nested directory that does not exist yet the way it will be", () => {
    const frame = new MemoryFrame({ dir: "./deep/nested/mem" }, host);
    expect(frame.configKey).toBe(path.join(fs.realpathSync(tmpRoot), "deep", "nested", "mem"));
  });

  it("preserves full MemoryConfig on the frame so nested options survive", () => {
    const config = {
      dir: "./full-config-mem",
      model: "gpt-4o",
      autoExtract: { interval: 5 },
      compaction: { trigger: "messages" as const, threshold: 50 },
      embeddings: { model: "text-embedding-3-small" },
    };
    const frame = new MemoryFrame(config, host);
    expect(frame.config).toEqual(config);
  });

  it("throws on empty dir", () => {
    expect(() => new MemoryFrame({ dir: "" }, host)).toThrow(/required/);
    expect(() => new MemoryFrame({ dir: "   " }, host)).toThrow(/required/);
  });

  it("expands leading `~` to $HOME (issue #230)", () => {
    // Without expansion, `path.resolve` treats `~` as a literal and
    // creates a real `~` directory under cwd. Verify the resolved
    // `configKey` lives under $HOME instead.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "memframe-home-"));
    const realFakeHome = fs.realpathSync(fakeHome);
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const frame = new MemoryFrame({ dir: "~/agency-mem-test" }, host);
      // configKey is realpath-resolved, so compare against the
      // realpath of $HOME.
      expect(frame.configKey).toBe(path.join(realFakeHome, "agency-mem-test"));
      // No literal `~` directory should have been created under cwd.
      expect(fs.existsSync(path.join(tmpRoot, "~"))).toBe(false);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  describe("equals (static)", () => {
    it("returns true for frames with same configKey, regardless of other config fields", () => {
      const a = new MemoryFrame({ dir: "./eqmem", model: "gpt-4o" }, host);
      const b = new MemoryFrame({ dir: "./eqmem", model: "gpt-5" }, host);
      expect(MemoryFrame.equals(a, b)).toBe(true);
    });

    it("returns false for frames with different configKey", () => {
      const a = new MemoryFrame({ dir: "./eq-a" }, host);
      const b = new MemoryFrame({ dir: "./eq-b" }, host);
      expect(MemoryFrame.equals(a, b)).toBe(false);
    });

    it("works on JSON-restored plain-object frames (no class prototype)", () => {
      const a = new MemoryFrame({ dir: "./jsonmem" }, host);
      // Simulate the post-serialization shape: plain object, no prototype.
      const restored = JSON.parse(JSON.stringify(a)) as MemoryFrame;
      expect(MemoryFrame.equals(a, restored)).toBe(true);
    });
  });
});
