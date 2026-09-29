import { describe, it, expect } from "vitest";
import { visionFiles } from "./visionFiles.js";

describe("visionFiles", () => {
  it("keeps the config, tokenizer, tag list, and one weight format, and drops the rest", () => {
    const files = [
      "config.json",
      "model.safetensors",
      "model.onnx",
      "selected_tags.csv",
      "tokenizer.json",
      "preprocessor_config.json",
      "pytorch_model.bin",
      "model.msgpack",
      "tf_model.h5",
      "modeling_florence2.py",
      "sample_inference.ipynb",
      "README.md",
    ].map((path) => ({ path, size: 1 }));
    expect(visionFiles(files).map((f) => f.path)).toEqual([
      "config.json",
      "model.safetensors",
      "model.onnx",
      "selected_tags.csv",
      "tokenizer.json",
      "preprocessor_config.json",
      "README.md",
    ]);
  });
});
