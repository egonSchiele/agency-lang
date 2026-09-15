import { describe, expect, it } from "vitest";
import { LOCKFILE, snapshotFor } from "../src/lockfile.js";

describe("snapshotFor", () => {
  it("lists the shared files and one model file at the pinned revision", () => {
    const snapshot = snapshotFor("fp32");

    expect(snapshot.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model.onnx",
    ]);
    expect(snapshotFor("q8").files.at(-1)?.path).toBe("onnx/model_quantized.onnx");
  });

  it("gives every file a hash, so the downloader checks each one", () => {
    const files = [...LOCKFILE.shared, ...Object.values(LOCKFILE.models)];
    expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256 ?? ""))).toBe(true);
  });
});
