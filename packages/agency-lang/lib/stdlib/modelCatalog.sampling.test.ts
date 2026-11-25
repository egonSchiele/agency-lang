import { describe, it, expect } from "vitest";
import { CURATED_LOCAL_MODELS, localSamplingFor } from "./modelCatalog.js";

describe("localSamplingFor", () => {
  it("finds an MLX entry by the repo id the server is asked for, revision or not", () => {
    expect(localSamplingFor("mlx-community/Qwen3.5-9B-4bit")).toEqual({
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
    });
    expect(localSamplingFor("mlx-community/gemma-4-31b-it-4bit")?.topK).toBe(64);
  });

  it("finds a GGUF entry by the file node-llama-cpp saves it as", () => {
    expect(localSamplingFor("/models/hf_unsloth_gemma-4-E4B-it.Q4_K_M.gguf")).toEqual({
      temperature: 1.0,
      topP: 0.95,
      topK: 64,
    });
    expect(localSamplingFor("hf_unsloth_Qwen3.5-2B.Q4_K_M.gguf")?.temperature).toBe(1.0);
    // Another quantization of the same repo is another file.
    expect(localSamplingFor("/models/hf_unsloth_Qwen3.5-2B.Q8_0.gguf")).toBeUndefined();
  });

  it("finds a GGUF in its model folder by the folder, whatever the file is called", () => {
    const folder = "/models/gguf/unsloth--Qwen3.8-Flash-Next-GGUF--UD-Q4_K_XL";
    expect(localSamplingFor(`${folder}/anything-00001-of-00004.gguf`)).toEqual({
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
    });
    // The same folder name outside the gguf folder is not a model folder.
    expect(
      localSamplingFor("/elsewhere/unsloth--Qwen3.8-Flash-Next-GGUF--UD-Q4_K_XL/model.gguf"),
    ).toBeUndefined();
  });

  it("finds an entry whose URI names a file instead of a tag, by its model folder", () => {
    const folder =
      "/models/gguf/prism-ml--Ternary-Bonsai-2.5-27B-GGUF--Ternary-Bonsai-2.5-27B-Q2_0.gguf";
    expect(localSamplingFor(`${folder}/Ternary-Bonsai-2.5-27B-Q2_0.gguf`)).toEqual({
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
    });
  });

  it("knows nothing about a model outside the catalog, or one whose entry names no sampling", () => {
    expect(localSamplingFor("/models/my-finetune.gguf")).toBeUndefined();
    expect(localSamplingFor("mlx-community/Qwen3-Embedding-4B-4bit-DWQ")).toBeUndefined();
    expect(localSamplingFor("")).toBeUndefined();
  });

  it("gives every chat model a sampling its backend can take", () => {
    for (const [name, entry] of Object.entries(CURATED_LOCAL_MODELS)) {
      if (entry.sampling === undefined) {
        continue;
      }
      const { temperature, topP, topK } = entry.sampling;
      expect(temperature, name).toBeGreaterThan(0);
      expect(temperature, name).toBeLessThanOrEqual(2);
      if (topP !== undefined) {
        expect(topP, name).toBeGreaterThan(0);
        expect(topP, name).toBeLessThanOrEqual(1);
      }
      if (topK !== undefined) {
        expect(Number.isInteger(topK), name).toBe(true);
      }
    }
  });
});
