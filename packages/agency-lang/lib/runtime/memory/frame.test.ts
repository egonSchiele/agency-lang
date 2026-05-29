import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryFrame } from "./frame.js";

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

  it("resolves a relative dir against process.cwd() and mkdir-p's it", () => {
    const frame = new MemoryFrame({ dir: "./relmem" });
    // realpath canonicalizes the tmp root too (on macOS /tmp -> /private/tmp).
    expect(frame.configKey).toBe(
      fs.realpathSync(path.resolve(tmpRoot, "relmem")),
    );
    expect(fs.existsSync(frame.configKey)).toBe(true);
  });

  it("does not re-resolve an already-absolute dir against cwd", () => {
    const absoluteDir = path.join(tmpRoot, "absmem");
    const frame = new MemoryFrame({ dir: absoluteDir });
    expect(frame.configKey).toBe(fs.realpathSync(absoluteDir));
  });

  it("auto-creates a nested directory tree if missing", () => {
    const nested = "./deep/nested/mem";
    const frame = new MemoryFrame({ dir: nested });
    expect(fs.existsSync(frame.configKey)).toBe(true);
    expect(frame.configKey).toContain("deep");
  });

  it("preserves full MemoryConfig on the frame so nested options survive", () => {
    const config = {
      dir: "./full-config-mem",
      model: "gpt-4o",
      autoExtract: { interval: 5 },
      compaction: { trigger: "messages" as const, threshold: 50 },
      embeddings: { model: "text-embedding-3-small" },
    };
    const frame = new MemoryFrame(config);
    expect(frame.config).toEqual(config);
  });

  it("throws on empty dir", () => {
    expect(() => new MemoryFrame({ dir: "" })).toThrow(/required/);
    expect(() => new MemoryFrame({ dir: "   " })).toThrow(/required/);
  });

  describe("equals (static)", () => {
    it("returns true for frames with same configKey, regardless of other config fields", () => {
      const a = new MemoryFrame({ dir: "./eqmem", model: "gpt-4o" });
      const b = new MemoryFrame({ dir: "./eqmem", model: "gpt-5" });
      expect(MemoryFrame.equals(a, b)).toBe(true);
    });

    it("returns false for frames with different configKey", () => {
      const a = new MemoryFrame({ dir: "./eq-a" });
      const b = new MemoryFrame({ dir: "./eq-b" });
      expect(MemoryFrame.equals(a, b)).toBe(false);
    });

    it("works on JSON-restored plain-object frames (no class prototype)", () => {
      const a = new MemoryFrame({ dir: "./jsonmem" });
      // Simulate the post-serialization shape: plain object, no prototype.
      const restored = JSON.parse(JSON.stringify(a)) as MemoryFrame;
      expect(MemoryFrame.equals(a, restored)).toBe(true);
    });
  });
});
