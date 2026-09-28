import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HubFile } from "./hubClient.js";
import { diffusersFiles, hasModelIndex, componentFolders } from "./diffusersFiles.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "__tests__", "fixtures");

/** A repo's file list as the Hub API returned it on 2026-09-28. */
function tree(name: string): HubFile[] {
  return JSON.parse(fs.readFileSync(path.join(fixtures, `hub-tree-${name}.json`), "utf8"));
}

const ZIMAGE_INDEX = {
  _class_name: "ZImagePipeline",
  scheduler: ["diffusers", "FlowMatchEulerDiscreteScheduler"],
  text_encoder: ["transformers", "Qwen3Model"],
  tokenizer: ["transformers", "Qwen2Tokenizer"],
  transformer: ["diffusers", "ZImageTransformer2DModel"],
  vae: ["diffusers", "AutoencoderKL"],
};

const CHROMA_INDEX = {
  _class_name: "ChromaPipeline",
  feature_extractor: [null, null],
  image_encoder: [null, null],
  scheduler: ["diffusers", "FlowMatchEulerDiscreteScheduler"],
  text_encoder: ["transformers", "T5EncoderModel"],
  tokenizer: ["transformers", "T5Tokenizer"],
  transformer: ["diffusers", "ChromaTransformer2DModel"],
  vae: ["diffusers", "AutoencoderKL"],
};

const totalGB = (files: HubFile[]) => files.reduce((sum, f) => sum + f.size, 0) / 1e9;

describe("diffusersFiles", () => {
  it("drops Chroma's single-file copy, README images, and workflow files", () => {
    const kept = diffusersFiles("lodestones/Chroma1-HD", tree("chroma"), CHROMA_INDEX);
    const paths = kept.map((f) => f.path);
    expect(paths).not.toContain("Chroma1-HD.safetensors");
    expect(paths).not.toContain("images/FictionalChromaBanner_1.png");
    expect(paths).not.toContain("README.md");
    expect(paths).toContain("model_index.json");
    expect(paths).toContain("tokenizer/spiece.model");
    expect(paths).toContain("transformer/diffusion_pytorch_model.safetensors.index.json");
    expect(totalGB(kept)).toBeCloseTo(27.49, 2);
  });

  it("keeps everything Z-Image's pipeline reads and nothing in assets/", () => {
    const kept = diffusersFiles("Tongyi-MAI/Z-Image-Turbo", tree("zimage"), ZIMAGE_INDEX);
    expect(kept.some((f) => f.path.startsWith("assets/"))).toBe(false);
    expect(kept.map((f) => f.path)).toContain("tokenizer/merges.txt");
    expect(totalGB(kept)).toBeCloseTo(32.85, 2);
  });

  it("keeps one .safetensors copy per component from an SDXL-shaped repo", () => {
    const files: HubFile[] = [
      { path: "model_index.json", size: 1 },
      { path: "sd_xl_base_1.0.safetensors", size: 100 },
      { path: "unet/config.json", size: 1 },
      { path: "unet/diffusion_pytorch_model.safetensors", size: 10 },
      { path: "unet/diffusion_pytorch_model.fp16.safetensors", size: 5 },
      { path: "unet/diffusion_pytorch_model.bin", size: 10 },
      { path: "unet/openvino_model.onnx", size: 10 },
      { path: "unet/onnx/model.onnx", size: 10 },
      { path: "vae/diffusion_pytorch_model.safetensors", size: 3 },
      { path: "vae/diffusion_pytorch_model.fp16-00001-of-00002.safetensors", size: 3 },
    ];
    const index = { _class_name: "X", unet: ["diffusers", "U"], vae: ["diffusers", "V"] };
    expect(diffusersFiles("org/sdxl", files, index).map((f) => f.path)).toEqual([
      "model_index.json",
      "unet/config.json",
      "unet/diffusion_pytorch_model.safetensors",
      "vae/diffusion_pytorch_model.safetensors",
    ]);
  });

  it("refuses a component whose only weights are not .safetensors, naming it", () => {
    const files: HubFile[] = [
      { path: "model_index.json", size: 1 },
      { path: "unet/config.json", size: 1 },
      { path: "unet/diffusion_pytorch_model.bin", size: 10 },
    ];
    expect(() =>
      diffusersFiles("org/old", files, { _class_name: "X", unet: ["diffusers", "U"] }),
    ).toThrow(
      "org/old's unet has no .safetensors weights. Agency's image server loads only .safetensors, so this model cannot be served.",
    );
  });

  it("a component with no weights at all, such as a tokenizer, is fine", () => {
    const files: HubFile[] = [
      { path: "model_index.json", size: 1 },
      { path: "tokenizer/vocab.json", size: 1 },
    ];
    const index = { _class_name: "X", tokenizer: ["transformers", "T"] };
    expect(diffusersFiles("org/t", files, index)).toHaveLength(2);
  });

  it("knows whether a repo has a model_index.json", () => {
    expect(hasModelIndex(tree("zimage"))).toBe(true);
    expect(hasModelIndex([{ path: "config.json", size: 1 }])).toBe(false);
  });

  it("reads component folders, skipping empty slots and underscore keys", () => {
    expect(componentFolders(CHROMA_INDEX)).toEqual([
      "scheduler",
      "text_encoder",
      "tokenizer",
      "transformer",
      "vae",
    ]);
    expect(() => componentFolders([1, 2])).toThrow("model_index.json is not a JSON object.");
  });
});
