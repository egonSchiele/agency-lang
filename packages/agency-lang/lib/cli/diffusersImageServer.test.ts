import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DIFFUSERS_VERSION, imageServerScript } from "./localServe.js";
import { MAX_STEPS } from "../stdlib/mlxImage.js";

const rulesModule = path.join(path.dirname(imageServerScript()), "diffusersImageRules.py");

// Every test here calls into Python, so the whole block skips once when
// there is no python3, instead of each test guarding itself.
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

/** Runs `code` with the rules module importable, and returns stdout. */
function rules(code: string): string {
  const run = spawnSync(
    "python3",
    [
      "-c",
      `import sys; sys.path.insert(0, sys.argv[1]); from diffusersImageRules import *\n${code}`,
      path.dirname(rulesModule),
    ],
    // No __pycache__ next to the source.
    { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  return run.stdout.toString().trim();
}

// The model_index.json files of the catalog models and of NoobAI-XL
// 1.1, an SDXL finetune, as downloaded.
const ZIMAGE_INDEX = {
  _class_name: "ZImagePipeline",
  _diffusers_version: "0.36.0.dev0",
  scheduler: ["diffusers", "FlowMatchEulerDiscreteScheduler"],
  text_encoder: ["transformers", "Qwen3Model"],
  tokenizer: ["transformers", "Qwen2Tokenizer"],
  transformer: ["diffusers", "ZImageTransformer2DModel"],
  vae: ["diffusers", "AutoencoderKL"],
};

const CHROMA_INDEX = {
  _class_name: "ChromaPipeline",
  _diffusers_version: "0.35.1",
  feature_extractor: [null, null],
  image_encoder: [null, null],
  scheduler: ["diffusers", "FlowMatchEulerDiscreteScheduler"],
  text_encoder: ["transformers", "T5EncoderModel"],
  tokenizer: ["transformers", "T5Tokenizer"],
  transformer: ["diffusers", "ChromaTransformer2DModel"],
  vae: ["diffusers", "AutoencoderKL"],
};

const SDXL_INDEX = {
  _class_name: "StableDiffusionXLPipeline",
  _diffusers_version: "0.31.0",
  feature_extractor: [null, null],
  force_zeros_for_empty_prompt: true,
  image_encoder: [null, null],
  scheduler: ["diffusers", "EulerDiscreteScheduler"],
  text_encoder: ["transformers", "CLIPTextModel"],
  text_encoder_2: ["transformers", "CLIPTextModelWithProjection"],
  tokenizer: ["transformers", "CLIPTokenizer"],
  tokenizer_2: ["transformers", "CLIPTokenizer"],
  unet: ["diffusers", "UNet2DConditionModel"],
  vae: ["diffusers", "AutoencoderKL"],
};

const QWEN_IMAGE_INDEX = {
  _class_name: "QwenImagePipeline",
  _diffusers_version: "0.36.0.dev0",
  scheduler: ["diffusers", "FlowMatchEulerDiscreteScheduler"],
  text_encoder: ["transformers", "Qwen2_5_VLForConditionalGeneration"],
  tokenizer: ["transformers", "Qwen2Tokenizer"],
  transformer: ["diffusers", "QwenImageTransformer2DModel"],
  vae: ["diffusers", "AutoencoderKLQwenImage"],
};

const KLEIN_INDEX = {
  _class_name: "Flux2KleinPipeline",
  _diffusers_version: "0.37.0.dev0",
  is_distilled: true,
  scheduler: ["diffusers", "FlowMatchEulerDiscreteScheduler"],
  text_encoder: ["transformers", "Qwen3ForCausalLM"],
  tokenizer: ["transformers", "Qwen2TokenizerFast"],
  transformer: ["diffusers", "Flux2Transformer2DModel"],
  vae: ["diffusers", "AutoencoderKLFlux2"],
};

type Family =
  | "ZImagePipeline"
  | "ChromaPipeline"
  | "QwenImagePipeline"
  | "Flux2KleinPipeline"
  | "StableDiffusionXLPipeline";

/** The family label for a model_index.json, or the refusal message. */
function familyOf(index: Record<string, unknown>): string {
  return rules(`
import json
try:
    print(family_of(json.loads(${JSON.stringify(JSON.stringify(index))}))["label"])
except ValueError as e:
    print("REFUSED", e)
`);
}

/** Runs check_request for a family and prints the result, or the error.
 *  The body is parsed from JSON in Python, since JSON's true and null are
 *  not Python's. `adaptersDir` is the configured adapters folder, if any. */
function check(family: Family, body: unknown, adaptersDir: string | null = null): string {
  return rules(`
import json
body = json.loads(${JSON.stringify(JSON.stringify(body))})
adapters_dir = json.loads(${JSON.stringify(JSON.stringify(adaptersDir))})
try:
    print(json.dumps(check_request(FAMILIES["${family}"], body, adapters_dir), sort_keys=True))
except RequestError as e:
    print("ERROR", e.status, e)
`);
}

/** adapter_path for one request name: the path, or the refusal. */
function adapterPath(name: unknown): string {
  return rules(`
import json
try:
    print(adapter_path("/a", json.loads(${JSON.stringify(JSON.stringify(name))})))
except RequestError as e:
    print("REFUSED", e)
`);
}

/** The pipeline arguments a request becomes for a family, or the error. */
function pipelineArgs(family: Family, body: unknown): Record<string, unknown> {
  return JSON.parse(
    rules(`
import json
rules = FAMILIES["${family}"]
body = json.loads(${JSON.stringify(JSON.stringify(body))})
print(json.dumps(pipeline_args(rules, check_request(rules, body)), sort_keys=True))
`),
  );
}

describe.skipIf(!hasPython3)("diffusersImageRules.py", () => {
  it("ships next to localServe", () => {
    expect(fs.existsSync(rulesModule)).toBe(true);
  });

  it("imports nothing from torch or diffusers, so CI can run it", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).not.toMatch(/^\s*(import|from)\s+(torch|diffusers|transformers)/m);
  });

  it("accepts the catalog models' model_index.json, and an SDXL finetune's", () => {
    expect(familyOf(ZIMAGE_INDEX)).toBe("Z-Image Turbo");
    expect(familyOf(CHROMA_INDEX)).toBe("Chroma");
    expect(familyOf(QWEN_IMAGE_INDEX)).toBe("Qwen-Image");
    expect(familyOf(KLEIN_INDEX)).toBe("FLUX.2 [klein]");
    expect(familyOf(SDXL_INDEX)).toBe("SDXL");
  });

  it("refuses a FLUX.2 [klein] model that is not step-distilled", () => {
    // The base model needs guidance and about 50 steps; the klein row
    // allows neither.
    expect(familyOf({ ...KLEIN_INDEX, is_distilled: false })).toBe(
      'REFUSED FLUX.2 [klein]\'s "is_distilled" must be True. This model_index.json says False.',
    );
    const { is_distilled: _distilled, ...unset } = KLEIN_INDEX;
    expect(familyOf(unset)).toBe(
      'REFUSED FLUX.2 [klein]\'s "is_distilled" must be True. This model_index.json does not set it.',
    );
  });

  it("refuses a setting the family does not list", () => {
    expect(familyOf({ ...QWEN_IMAGE_INDEX, is_distilled: true })).toBe(
      'REFUSED Qwen-Image has no component "is_distilled", and this model_index.json names one.',
    );
  });

  it("refuses a pipeline class it does not serve", () => {
    expect(familyOf({ ...ZIMAGE_INDEX, _class_name: "StableDiffusionPipeline" })).toBe(
      'REFUSED diffusersImageServer.py serves ChromaPipeline, Flux2KleinPipeline, QwenImagePipeline, StableDiffusionXLPipeline, and ZImagePipeline models. This model_index.json names "StableDiffusionPipeline".',
    );
  });

  it("refuses a setting whose value differs from the table, or that is missing", () => {
    expect(familyOf({ ...SDXL_INDEX, force_zeros_for_empty_prompt: false })).toBe(
      'REFUSED SDXL\'s "force_zeros_for_empty_prompt" must be True. This model_index.json says False.',
    );
    const { force_zeros_for_empty_prompt: _setting, ...noSetting } = SDXL_INDEX;
    expect(familyOf(noSetting)).toBe(
      'REFUSED SDXL\'s "force_zeros_for_empty_prompt" must be True. This model_index.json does not set it.',
    );
    // A setting is not a component: Z-Image's table has none, so one is refused as a component.
    expect(familyOf({ ...ZIMAGE_INDEX, force_zeros_for_empty_prompt: true })).toBe(
      'REFUSED Z-Image Turbo has no component "force_zeros_for_empty_prompt", and this model_index.json names one.',
    );
  });

  it("refuses a component whose class or library differs from the table", () => {
    expect(familyOf({ ...ZIMAGE_INDEX, vae: ["diffusers", "SomethingElse"] })).toBe(
      "REFUSED Z-Image Turbo's \"vae\" must be ['diffusers', 'AutoencoderKL']. This model_index.json says ['diffusers', 'SomethingElse'].",
    );
    expect(familyOf({ ...ZIMAGE_INDEX, vae: ["os", "system"] })).toBe(
      "REFUSED Z-Image Turbo's \"vae\" must be ['diffusers', 'AutoencoderKL']. This model_index.json says ['os', 'system'].",
    );
  });

  it("refuses a component the table does not list, and one it is missing", () => {
    expect(familyOf({ ...ZIMAGE_INDEX, safety_checker: ["mymodule", "Checker"] })).toBe(
      'REFUSED Z-Image Turbo has no component "safety_checker", and this model_index.json names one.',
    );
    const { vae: _vae, ...noVae } = CHROMA_INDEX;
    expect(familyOf(noVae)).toBe(
      "REFUSED This model_index.json does not name vae, which Chroma needs.",
    );
  });

  it("fills in the model card's settings for an empty request", () => {
    const out = JSON.parse(check("ZImagePipeline", { prompt: "a cat", seed: 7 }));
    expect(out).toEqual({
      prompt: "a cat",
      width: 1024,
      height: 1024,
      steps: 9,
      guidance: 0.0,
      seed: 7,
      negative_prompt: "",
      output_format: "png",
      lora: null,
      lora_scale: 1.0,
    });
    const chroma = JSON.parse(check("ChromaPipeline", { prompt: "a cat", seed: 7 }));
    expect([chroma.steps, chroma.guidance]).toEqual([40, 3.0]);
    const sdxl = JSON.parse(check("StableDiffusionXLPipeline", { prompt: "a cat", seed: 7 }));
    expect([sdxl.steps, sdxl.guidance]).toEqual([28, 5.5]);
  });

  it("picks a seed when the request names none", () => {
    const out = JSON.parse(check("ZImagePipeline", { prompt: "a cat" }));
    expect(Number.isInteger(out.seed)).toBe(true);
    expect(out.seed).toBeGreaterThanOrEqual(0);
    expect(out.seed).toBeLessThanOrEqual(2 ** 32 - 1);
  });

  it("takes a negative prompt and guidance for Chroma", () => {
    const out = JSON.parse(
      check("ChromaPipeline", {
        prompt: "a cat",
        negative_prompt: "blurry",
        guidance: 4.5,
        steps: 30,
        size: "2048x1920",
        output_format: "webp",
        n: 1,
        response_format: "b64_json",
        model: "/some/dir",
      }),
    );
    expect(out).toMatchObject({
      negative_prompt: "blurry",
      guidance: 4.5,
      steps: 30,
      width: 2048,
      height: 1920,
      output_format: "webp",
    });
  });

  it("refuses what Z-Image Turbo cannot use", () => {
    expect(check("ZImagePipeline", { prompt: "a cat", negative_prompt: "blurry" })).toBe(
      "ERROR 400 Z-Image Turbo does not use a negative prompt, because it runs without guidance. Leave negative_prompt empty.",
    );
    expect(check("ZImagePipeline", { prompt: "a cat", guidance: 3 })).toBe(
      "ERROR 400 Z-Image Turbo runs without guidance. Leave guidance empty.",
    );
  });

  it("accepts a guidance equal to the family's own value", () => {
    // A caller that copies the default from the docs is not asking for guidance.
    const out = JSON.parse(check("ZImagePipeline", { prompt: "a cat", guidance: 0 }));
    expect(out.guidance).toBe(0);
  });

  it("refuses steps outside the family's range", () => {
    const message =
      "ERROR 400 steps must be between 1 and 50 for Z-Image Turbo. Its model card uses 9.";
    expect(check("ZImagePipeline", { prompt: "a cat", steps: 0 })).toBe(message);
    expect(check("ZImagePipeline", { prompt: "a cat", steps: 51 })).toBe(message);
    expect(check("ZImagePipeline", { prompt: "a cat", steps: 2.5 })).toBe(message);
    expect(check("ZImagePipeline", { prompt: "a cat", steps: true })).toBe(message);
  });

  it("refuses sizes that are malformed, not multiples of 16, or too large", () => {
    const shape = 'ERROR 400 size must be two multiples of 16 joined by "x", such as "1024x1024".';
    expect(check("ZImagePipeline", { prompt: "a cat", size: "1000x1000" })).toBe(shape);
    expect(check("ZImagePipeline", { prompt: "a cat", size: "big" })).toBe(shape);
    expect(check("ZImagePipeline", { prompt: "a cat", size: 1024 })).toBe(shape);
    expect(check("ZImagePipeline", { prompt: "a cat", size: "4096x4096" })).toBe(
      "ERROR 400 Each side of size must be from 256 to 2048.",
    );
    expect(check("ZImagePipeline", { prompt: "a cat", size: "4096x960" })).toBe(
      "ERROR 400 Each side of size must be from 256 to 2048.",
    );
    expect(check("ZImagePipeline", { prompt: "a cat", size: "2048x2048" })).toBe(
      "ERROR 400 size 2048x2048 is 4,194,304 pixels; this server makes at most 4,000,000.",
    );
  });

  it("refuses a missing or empty prompt", () => {
    const message = "ERROR 400 prompt must be a non-empty string.";
    expect(check("ZImagePipeline", {})).toBe(message);
    expect(check("ZImagePipeline", { prompt: "  " })).toBe(message);
    expect(check("ZImagePipeline", { prompt: 5 })).toBe(message);
  });

  it("refuses OpenAI settings it does not take", () => {
    expect(check("ZImagePipeline", { prompt: "a cat", quality: "high" })).toBe(
      "ERROR 400 quality is not a setting of this server. Use steps instead.",
    );
    expect(check("ZImagePipeline", { prompt: "a cat", n: 2 })).toBe(
      "ERROR 400 n must be 1. Make one request per image.",
    );
    expect(check("ZImagePipeline", { prompt: "a cat", response_format: "url" })).toBe(
      'ERROR 400 response_format "url" is not supported. This server returns b64_json only.',
    );
    expect(check("ZImagePipeline", { prompt: "a cat", output_format: "gif" })).toBe(
      'ERROR 400 output_format "gif" is not supported. Use png, jpeg, or webp.',
    );
  });

  it("applies an adapter from the folder only to the request that names it", () => {
    const named = JSON.parse(
      check(
        "StableDiffusionXLPipeline",
        { prompt: "a cat", lora: "sketch", lora_scale: 0.8 },
        "/a",
      ),
    );
    expect([named.lora, named.lora_scale]).toEqual(["sketch", 0.8]);
    const unscaled = JSON.parse(
      check("StableDiffusionXLPipeline", { prompt: "a cat", lora: "inky" }, "/a"),
    );
    expect([unscaled.lora, unscaled.lora_scale]).toEqual(["inky", 1.0]);
    const none = JSON.parse(check("StableDiffusionXLPipeline", { prompt: "a cat" }, "/a"));
    expect([none.lora, none.lora_scale]).toEqual([null, 1.0]);
  });

  it("refuses an adapter with no folder configured, and one for a family that takes none", () => {
    expect(check("StableDiffusionXLPipeline", { prompt: "a cat", lora: "sketch" })).toBe(
      "ERROR 400 This server has no adapters folder. Set client.adaptersDir in agency.json to the folder your .safetensors adapters are in, and start the server again.",
    );
    expect(check("ChromaPipeline", { prompt: "a cat", lora: "sketch" }, "/a")).toBe(
      "ERROR 400 Chroma does not take LoRA adapters. Leave lora empty.",
    );
  });

  it("refuses a scale without an adapter, or out of range", () => {
    expect(check("StableDiffusionXLPipeline", { prompt: "a cat", lora_scale: 1 })).toBe(
      "ERROR 400 lora_scale needs lora: it says how strongly to apply the adapter.",
    );
    const message =
      "ERROR 400 lora_scale must be a number from 0 to 2.0. 1 applies the adapter as trained.";
    const loaded = "/a";
    expect(
      check(
        "StableDiffusionXLPipeline",
        { prompt: "a cat", lora: "sketch", lora_scale: 3 },
        loaded,
      ),
    ).toBe(message);
    expect(
      check(
        "StableDiffusionXLPipeline",
        { prompt: "a cat", lora: "sketch", lora_scale: "1" },
        loaded,
      ),
    ).toBe(message);
    expect(
      check(
        "StableDiffusionXLPipeline",
        { prompt: "a cat", lora: "sketch", lora_scale: true },
        loaded,
      ),
    ).toBe(message);
  });

  it("joins an adapter name to the folder, and refuses a name that is not one file name", () => {
    expect(adapterPath("sketch")).toBe("/a/sketch.safetensors");
    expect(adapterPath("my-style_2")).toBe("/a/my-style_2.safetensors");
    expect(adapterPath("style.v2")).toBe("/a/style.v2.safetensors");
    const refused =
      'REFUSED lora must be an adapter\'s name: its file name in the adapters folder without .safetensors, such as "sketch" for sketch.safetensors. Got ';
    expect(adapterPath("../x")).toBe(`${refused}'../x'.`);
    expect(adapterPath("a/b")).toBe(`${refused}'a/b'.`);
    expect(adapterPath("sketch.safetensors")).toBe(`${refused}'sketch.safetensors'.`);
    expect(adapterPath("")).toBe(`${refused}''.`);
    expect(adapterPath(".")).toBe(`${refused}'.'.`);
    expect(adapterPath(7)).toBe(`${refused}7.`);
  });

  it("lists the adapters in a folder by name, and none for a folder that is not there", () => {
    const out = rules(`
import os, tempfile
d = tempfile.mkdtemp()
for name in ["b.safetensors", "a.safetensors", "notes.txt"]:
    open(os.path.join(d, name), "w").close()
print(adapter_names(d))
print(adapter_names(os.path.join(d, "missing")))
`);
    expect(out.split("\n")).toEqual(["['a', 'b']", "[]"]);
  });

  it("lists only the adapters a request could load", () => {
    // A symlink, a folder, and a file whose name a request cannot spell
    // are all left out, so /health never lists an adapter that then fails.
    const out = rules(`
import os, shutil, tempfile
d = tempfile.mkdtemp()
open(os.path.join(d, "style.v2.safetensors"), "w").close()
open(os.path.join(d, "x.safetensors.safetensors"), "w").close()
os.mkdir(os.path.join(d, "folder.safetensors"))
os.symlink(os.path.join(d, "style.v2.safetensors"), os.path.join(d, "link.safetensors"))
print(adapter_names(d))
shutil.rmtree(d)
`);
    expect(out).toBe("['style.v2']");
  });

  it("finds an adapter's file and its stamp, and refuses a symlink or a missing file", () => {
    const out = rules(`
import os, shutil, tempfile
d = tempfile.mkdtemp()
target = os.path.join(d, "sketch.safetensors")
with open(target, "w") as f:
    f.write("one")
path, stamp = existing_adapter(d, "sketch")
print(path == target, stamp[1])
with open(target, "w") as f:
    f.write("retrained")
print(existing_adapter(d, "sketch")[1] != stamp)
os.symlink(target, os.path.join(d, "link.safetensors"))
for name in ["link", "missing"]:
    try:
        existing_adapter(d, name)
    except RequestError as e:
        print(str(e).replace(d, "DIR"))
shutil.rmtree(d)
`);
    expect(out.split("\n")).toEqual([
      "True 3",
      "True",
      'There is no adapter "link" in DIR. It has sketch.',
      'There is no adapter "missing" in DIR. It has sketch.',
    ]);
  });

  it("refuses an adapters folder that is a symlink or not a folder", () => {
    const out = rules(`
import os, shutil, tempfile
d = tempfile.mkdtemp()
folder = os.path.join(d, "adapters")
os.mkdir(folder)
os.symlink(folder, os.path.join(d, "link"))
print(check_adapters_dir(folder) == folder, check_adapters_dir(None))
for name in ["link", "missing"]:
    try:
        check_adapters_dir(os.path.join(d, name))
    except ValueError as e:
        print(str(e).replace(d, "DIR"))
shutil.rmtree(d)
`);
    expect(out.split("\n")).toEqual([
      "True None",
      "--adapters-dir DIR/link is a symlink. Name the folder itself.",
      "--adapters-dir DIR/missing is not a folder.",
    ]);
  });

  it("loads each adapter under a fresh name without dots, and keeps at most two", () => {
    const out = rules(`
a = LoadedAdapters(limit=2)
def use(name, stamp):
    found = a.find(name, stamp)
    if found is not None:
        return f"{name}: kept {found}"
    dropped = a.make_room(name)
    loaded_as = a.next_name()
    a.add(name, loaded_as, stamp)
    return f"{name}: load {loaded_as}, unload {dropped}"
print(use("style.v2", [1, 10]))
print(use("sketch", [1, 20]))
print(use("style.v2", [1, 10]))
print(use("inky", [1, 30]))
print(use("style.v2", [2, 11]))
`);
    expect(out.split("\n")).toEqual([
      "style.v2: load adapter_0, unload []",
      "sketch: load adapter_1, unload []",
      "style.v2: kept adapter_0",
      // sketch was used longest ago, so it makes room for inky.
      "inky: load adapter_2, unload ['adapter_1']",
      // A retrained file has a new stamp: the old load goes, the new one gets a new name.
      "style.v2: load adapter_3, unload ['adapter_0']",
    ]);
  });

  it("refuses a field it does not know, naming the ones it takes", () => {
    expect(check("ZImagePipeline", { prompt: "a cat", style: "vivid" })).toBe(
      "ERROR 400 style is not a setting of this server. It takes prompt, size, steps, guidance, seed, negative_prompt, output_format, response_format, n, lora, and lora_scale.",
    );
  });

  it("refuses a seed that is not a whole number in range", () => {
    const message = "ERROR 400 seed must be a whole number from 0 to 4294967295.";
    expect(check("ZImagePipeline", { prompt: "a cat", seed: -1 })).toBe(message);
    expect(check("ZImagePipeline", { prompt: "a cat", seed: 2 ** 32 })).toBe(message);
    expect(check("ZImagePipeline", { prompt: "a cat", seed: "7" })).toBe(message);
  });

  it("refuses a body that is not an object", () => {
    expect(check("ZImagePipeline", ["a cat"])).toBe(
      "ERROR 400 The request body must be a JSON object.",
    );
  });

  it("builds a small warm-up request that passes its own checks", () => {
    const out = rules(`
import json
body = warm_up_request()
for family in FAMILIES.values():
    r = check_request(family, body)
    print(r["width"], r["height"], r["steps"])
`);
    expect(out.split("\n")).toEqual(Array(5).fill("512 512 2"));
  });

  it("passes guidance to the argument each family's pipeline reads", () => {
    expect(pipelineArgs("ChromaPipeline", { prompt: "a cat", seed: 1 })).toEqual({
      prompt: "a cat",
      height: 1024,
      width: 1024,
      num_inference_steps: 40,
      guidance_scale: 3.0,
    });
    // Qwen-Image ignores guidance_scale; true_cfg_scale is its guidance.
    expect(pipelineArgs("QwenImagePipeline", { prompt: "a cat", guidance: 5 })).toMatchObject({
      num_inference_steps: 50,
      true_cfg_scale: 5,
    });
    expect(pipelineArgs("QwenImagePipeline", { prompt: "a cat" })).not.toHaveProperty(
      "guidance_scale",
    );
  });

  it("sends Qwen-Image a blank negative prompt when the request has none", () => {
    // Without a negative prompt the pipeline skips guidance altogether.
    expect(pipelineArgs("QwenImagePipeline", { prompt: "a cat" }).negative_prompt).toBe(" ");
    expect(
      pipelineArgs("QwenImagePipeline", { prompt: "a cat", negative_prompt: "blurry" })
        .negative_prompt,
    ).toBe("blurry");
    expect(pipelineArgs("ChromaPipeline", { prompt: "a cat" })).not.toHaveProperty(
      "negative_prompt",
    );
  });

  it("runs FLUX.2 [klein] at the model card's 4 steps with no guidance", () => {
    expect(pipelineArgs("Flux2KleinPipeline", { prompt: "a cat" })).toEqual({
      prompt: "a cat",
      height: 1024,
      width: 1024,
      num_inference_steps: 4,
      guidance_scale: 1.0,
    });
    expect(check("Flux2KleinPipeline", { prompt: "a cat", guidance: 4 })).toBe(
      "ERROR 400 FLUX.2 [klein] runs without guidance. Leave guidance empty.",
    );
  });

  it("pins the same diffusers version as localServe.ts", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).toContain(`DIFFUSERS_VERSION = "${DIFFUSERS_VERSION}"`);
  });

  it("allows no family more steps than the provider's timeout budgets", () => {
    const most = Number(rules("print(max(f['max_steps'] for f in FAMILIES.values()))"));
    expect(most).toBe(MAX_STEPS);
  });
});

describe.skipIf(!hasPython3)("diffusersImageServer.py", () => {
  it("ships next to localServe", () => {
    const script = imageServerScript();
    expect(script.endsWith("/lib/cli/diffusersImageServer.py")).toBe(true);
    expect(fs.existsSync(script)).toBe(true);
  });

  // A syntax check only. Running the server needs torch and a Mac GPU,
  // which CI has not.
  it("is valid Python 3", () => {
    const run = spawnSync(
      "python3",
      ["-c", "import ast, sys; ast.parse(open(sys.argv[1]).read())", imageServerScript()],
      { stdio: "pipe" },
    );
    expect(run.stderr.toString()).toBe("");
    expect(run.status).toBe(0);
  });
});
