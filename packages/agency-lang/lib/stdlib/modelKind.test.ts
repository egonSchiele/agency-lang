import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { kindOfModelDir, isModelKind, MODEL_KINDS } from "./modelKind.js";

describe("kindOfModelDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kind-")));
  });

  afterEach(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  });

  /** A model directory holding the given files, each with JSON or text. */
  function modelDir(name: string, files: Record<string, unknown>): string {
    const model = path.join(dir, name);
    fs.mkdirSync(model, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      const text = typeof contents === "string" ? contents : JSON.stringify(contents);
      fs.writeFileSync(path.join(model, file), text);
    }
    return model;
  }

  it("says image for any diffusers directory, whatever its pipeline", () => {
    // The image server decides which pipelines it runs, so a family it does
    // not serve (or one added after this build) is still an image model.
    for (const pipeline of ["ZImagePipeline", "QwenImagePipeline", "StableDiffusionPipeline"]) {
      const model = modelDir(pipeline, { "model_index.json": { _class_name: pipeline } });
      fs.mkdirSync(path.join(model, "transformer"));
      fs.writeFileSync(path.join(model, "transformer", "model.safetensors"), "x");
      expect(kindOfModelDir(model)).toBe("image");
    }
  });

  it("says nothing for a model_index.json with no weights beside it", () => {
    const bare = modelDir("bare", { "model_index.json": { _class_name: "ZImagePipeline" } });
    expect(kindOfModelDir(bare)).toBeNull();
  });

  it("says chat for a causal language model, and for a GGUF file's directory", () => {
    const qwen = modelDir("qwen", {
      "config.json": { model_type: "qwen3", architectures: ["Qwen3ForCausalLM"] },
      "model.safetensors": "x",
    });
    expect(kindOfModelDir(qwen)).toBe("chat");
    const gemma = modelDir("gemma", {
      "config.json": { architectures: ["Gemma3ForConditionalGeneration"] },
    });
    expect(kindOfModelDir(gemma)).toBe("chat");
    const gguf = modelDir("gguf", { "tiny.Q4_K_M.gguf": "GGUF" });
    expect(kindOfModelDir(gguf)).toBe("chat");
  });

  it("says embedding for an encoder with no generation head", () => {
    const embedding = modelDir("embed", {
      "config.json": { model_type: "qwen3", architectures: ["Qwen3Model"] },
    });
    expect(kindOfModelDir(embedding)).toBe("embedding");
  });

  it("says vision for a tagger's two files, and for Florence-2 before the chat rule sees it", () => {
    const tagger = modelDir("wd14", { "model.onnx": "onnx", "selected_tags.csv": "tag_id,name" });
    expect(kindOfModelDir(tagger)).toBe("vision");
    const florence = modelDir("florence", {
      "config.json": { architectures: ["Florence2ForConditionalGeneration"] },
    });
    expect(kindOfModelDir(florence)).toBe("vision");
  });

  it("says vision for DINOv2 and OWLv2, before the embedding rule sees DINOv2's Model suffix", () => {
    const dinov2 = modelDir("dinov2", { "config.json": { architectures: ["Dinov2Model"] } });
    expect(kindOfModelDir(dinov2)).toBe("vision");
    const owlv2 = modelDir("owlv2", {
      "config.json": { architectures: ["Owlv2ForObjectDetection"] },
    });
    expect(kindOfModelDir(owlv2)).toBe("vision");
  });

  it("says controlnet for a diffusers ControlNet directory", () => {
    const controlnet = modelDir("cn", {
      "config.json": { _class_name: "ControlNetModel" },
      "diffusion_pytorch_model.safetensors": "x",
    });
    expect(kindOfModelDir(controlnet)).toBe("controlnet");
  });

  it("says speech for a Qwen3-TTS config", () => {
    const tts = modelDir("tts", {
      "config.json": { model_type: "qwen3_tts", tts_model_type: "custom_voice" },
    });
    expect(kindOfModelDir(tts)).toBe("speech");
  });

  it("says nothing for a directory whose files match no rule", () => {
    const empty = modelDir("empty", { "README.md": "hello" });
    expect(kindOfModelDir(empty)).toBeNull();
    const noArch = modelDir("noarch", { "config.json": { hidden_size: 4096 } });
    expect(kindOfModelDir(noArch)).toBeNull();
    const notJson = modelDir("notjson", { "config.json": "{not json" });
    expect(kindOfModelDir(notJson)).toBeNull();
  });

  /** A Hub cache snapshot whose config.json links to `target`. */
  function snapshotLinkingTo(target: string): string {
    const snapshot = path.join(dir, "models--org--repo", "snapshots", "abc");
    fs.mkdirSync(snapshot, { recursive: true });
    fs.symlinkSync(target, path.join(snapshot, "config.json"));
    return snapshot;
  }

  const llamaConfig = JSON.stringify({ architectures: ["LlamaForCausalLM"] });

  it("reads through a Hub cache snapshot's links into its own blobs", () => {
    const blobs = path.join(dir, "models--org--repo", "blobs");
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, "abc"), llamaConfig);
    expect(kindOfModelDir(snapshotLinkingTo(path.join(blobs, "abc")))).toBe("chat");
  });

  it("refuses a link that leaves the Hub repo folder, or any link outside a Hub cache", () => {
    const outside = modelDir("outside", { "config.json": llamaConfig });
    expect(kindOfModelDir(snapshotLinkingTo(path.join(outside, "config.json")))).toBeNull();
    const plain = path.join(dir, "plain");
    fs.mkdirSync(plain);
    fs.symlinkSync(path.join(outside, "config.json"), path.join(plain, "config.json"));
    expect(kindOfModelDir(plain)).toBeNull();
  });

  it("does not read a config.json over 1 MB, or one that is not a regular file", () => {
    const padding = " ".repeat(1024 * 1024);
    const big = modelDir("big", {
      "config.json": `{"architectures": ["LlamaForCausalLM"]}${padding}`,
    });
    expect(kindOfModelDir(big)).toBeNull();
    const notFile = path.join(dir, "notfile");
    fs.mkdirSync(path.join(notFile, "config.json"), { recursive: true });
    expect(kindOfModelDir(notFile)).toBeNull();
  });
});

describe("isModelKind", () => {
  it("accepts every kind and nothing else", () => {
    for (const kind of MODEL_KINDS) {
      expect(isModelKind(kind)).toBe(true);
    }
    expect(isModelKind("lora")).toBe(false);
    expect(isModelKind(3)).toBe(false);
  });
});
