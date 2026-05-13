import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureModel, ModelManagerError } from "../src/modelManager.js";

// ensureModel is the entry point for the download pipeline. It has three
// non-trivial branches: file already on disk, lockfile placeholder hash, and
// the actual download. We exercise the first two here; the third is covered
// by the integration test (which actually downloads tiny.en).

describe("ensureModel", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-ensure-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns the existing path without downloading when the file is on disk", async () => {
    const dest = path.join(tmp, "ggml-base.bin");
    await fs.writeFile(dest, "pretend this is a real model");
    const out = await ensureModel("base", tmp);
    expect(out).toBe(dest);
    // File should still exist and be untouched (size matches what we wrote).
    const stat = await fs.stat(dest);
    expect(stat.size).toBe("pretend this is a real model".length);
  });

  it("rejects when the lockfile entry has a placeholder hash", async () => {
    // The shipped lockfile has `base` (no .en) as a placeholder. ensureModel
    // should refuse to download it rather than treat 0*64 as a valid hash.
    await expect(ensureModel("base", tmp)).rejects.toThrow(
      /placeholder hash/,
    );
  });

  it("rejects placeholder error includes the model name and a setup hint", async () => {
    await expect(ensureModel("small", tmp)).rejects.toThrow(/small/);
    await expect(ensureModel("small", tmp)).rejects.toThrow(/setup bug/);
  });

  it("rejects errors are typed as ModelManagerError", async () => {
    try {
      await ensureModel("medium", tmp);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelManagerError);
    }
  });
});
