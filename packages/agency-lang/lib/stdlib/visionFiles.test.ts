import { describe, it, expect } from "vitest";
import { visionFiles } from "./visionFiles.js";

const hubFiles = (paths: string[]) => paths.map((path) => ({ path, size: 1 }));

describe("visionFiles", () => {
  it("keeps only the ONNX weights of a WD14 tagger, with its tag list", () => {
    const files = hubFiles([
      "config.json",
      "model.safetensors",
      "model.onnx",
      "selected_tags.csv",
      "model.msgpack",
      "sample_inference.ipynb",
      "README.md",
    ]);
    expect(visionFiles(files).map((f) => f.path)).toEqual([
      "config.json",
      "model.onnx",
      "selected_tags.csv",
      "README.md",
    ]);
  });

  it("keeps the safetensors weights, config, and tokenizer of a transformers model, and drops the rest", () => {
    const files = hubFiles([
      "config.json",
      "model.safetensors",
      "tokenizer.json",
      "preprocessor_config.json",
      "pytorch_model.bin",
      "tf_model.h5",
      "modeling_florence2.py",
      "README.md",
    ]);
    expect(visionFiles(files).map((f) => f.path)).toEqual([
      "config.json",
      "model.safetensors",
      "tokenizer.json",
      "preprocessor_config.json",
      "README.md",
    ]);
  });
});
