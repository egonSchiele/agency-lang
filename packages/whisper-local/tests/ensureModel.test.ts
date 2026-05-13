import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureModel, ModelManagerError } from "../src/modelManager.js";

// ensureModel is the entry point for the download pipeline. The three
// non-trivial branches it has are:
//   1. file already on disk (no download)             — tested here
//   2. unknown model name (rejected by resolveModelPath) — tested here
//   3. actual download                                 — covered by the gated
//      integration test in tests/integration.test.ts
//
// The placeholder-hash branch in the source is intentionally dead in shipped
// code (KNOWN_MODELS only lists models whose lockfile entries have real
// hashes). It is kept as a defensive guard against future regressions; we
// do not exercise it here.

describe("ensureModel", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-ensure-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns the existing path without downloading when the file is on disk", async () => {
    const dest = path.join(tmp, "ggml-base.en.bin");
    await fs.writeFile(dest, "pretend this is a real model");
    const out = await ensureModel("base.en", tmp);
    expect(out).toBe(dest);
    // File should still exist and be untouched (size matches what we wrote).
    const stat = await fs.stat(dest);
    expect(stat.size).toBe("pretend this is a real model".length);
  });

  it("rejects with ModelManagerError for a model not in KNOWN_MODELS", async () => {
    // resolveModelPath rejects unknown names up front (before the file
    // existence check or the lockfile lookup), so ensureModel inherits
    // that rejection. Use a name that cannot ever be a real whisper model.
    await expect(
      ensureModel("definitely-not-a-real-whisper-model" as never, tmp),
    ).rejects.toBeInstanceOf(ModelManagerError);
    await expect(
      ensureModel("definitely-not-a-real-whisper-model" as never, tmp),
    ).rejects.toThrow(/unknown model/);
  });
});
