import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { kindOfModelDir, isModelKind, IMAGE_PIPELINES, MODEL_KINDS } from "./modelKind.js";
import { imageServerScript } from "../cli/localServe.js";

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

  it("says image for a model_index.json naming a served pipeline", () => {
    const zImage = modelDir("zimage", {
      "model_index.json": { _class_name: "ZImagePipeline", vae: ["diffusers", "AutoencoderKL"] },
    });
    expect(kindOfModelDir(zImage)).toBe("image");
    const chroma = modelDir("chroma", { "model_index.json": { _class_name: "ChromaPipeline" } });
    expect(kindOfModelDir(chroma)).toBe("image");
  });

  it("says nothing for a diffusers pipeline the image server does not serve", () => {
    const other = modelDir("sd15", {
      "model_index.json": { _class_name: "StableDiffusionPipeline" },
    });
    expect(kindOfModelDir(other)).toBeNull();
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

  it("reads through a Hub cache snapshot's symlinks", () => {
    const blobs = modelDir("blobs", {
      abc: JSON.stringify({ architectures: ["LlamaForCausalLM"] }),
    });
    const snapshot = path.join(dir, "snapshot");
    fs.mkdirSync(snapshot);
    fs.symlinkSync(path.join(blobs, "abc"), path.join(snapshot, "config.json"));
    expect(kindOfModelDir(snapshot)).toBe("chat");
  });
});

describe("isModelKind", () => {
  it("accepts every kind and nothing else", () => {
    for (const kind of MODEL_KINDS) {
      expect(isModelKind(kind)).toBe(true);
    }
    expect(isModelKind("controlnet")).toBe(false);
    expect(isModelKind(3)).toBe(false);
  });
});

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

describe.skipIf(!hasPython3)("IMAGE_PIPELINES", () => {
  it("lists the same pipelines as the image server's family table", () => {
    const rules = path.join(path.dirname(imageServerScript()), "diffusersImageRules.py");
    const run = spawnSync(
      "python3",
      [
        "-c",
        "import sys, json; sys.path.insert(0, sys.argv[1]); from diffusersImageRules import FAMILIES; print(json.dumps(sorted(FAMILIES)))",
        path.dirname(rules),
      ],
      { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual([...IMAGE_PIPELINES].sort());
  });
});
