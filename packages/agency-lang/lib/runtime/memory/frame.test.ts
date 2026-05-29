import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeMemoryFrame } from "./frame.js";

describe("normalizeMemoryFrame", () => {
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
    const frame = normalizeMemoryFrame({ dir: "./relmem" });
    // realpath canonicalizes the tmp root too (on macOS /tmp -> /private/tmp).
    expect(frame.configKey).toBe(
      fs.realpathSync(path.resolve(tmpRoot, "relmem")),
    );
    expect(fs.existsSync(frame.configKey)).toBe(true);
  });

  it("does not re-resolve an already-absolute dir against cwd", () => {
    const absoluteDir = path.join(tmpRoot, "absmem");
    const frame = normalizeMemoryFrame({ dir: absoluteDir });
    expect(frame.configKey).toBe(fs.realpathSync(absoluteDir));
  });

  it("auto-creates a nested directory tree if missing", () => {
    const nested = "./deep/nested/mem";
    const frame = normalizeMemoryFrame({ dir: nested });
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
    const frame = normalizeMemoryFrame(config);
    expect(frame.config).toEqual(config);
  });

  it("throws on empty dir", () => {
    expect(() => normalizeMemoryFrame({ dir: "" })).toThrow(/required/);
    expect(() => normalizeMemoryFrame({ dir: "   " })).toThrow(/required/);
  });
});
