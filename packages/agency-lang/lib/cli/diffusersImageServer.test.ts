import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
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

// The model_index.json files of the two catalog models and of NoobAI-XL
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
 *  not Python's. `adaptersDir` is the configured adapters folder, if any.
 *  A control image's bytes print as their length. */
function check(
  family: "ZImagePipeline" | "ChromaPipeline" | "StableDiffusionXLPipeline",
  body: unknown,
  adaptersDir: string | null = null,
  controlnetsDir: string | null = null,
): string {
  return rules(`
import json
body = json.loads(${JSON.stringify(JSON.stringify(body))})
adapters_dir = json.loads(${JSON.stringify(JSON.stringify(adaptersDir))})
controlnets_dir = json.loads(${JSON.stringify(JSON.stringify(controlnetsDir))})
try:
    checked = check_request(FAMILIES["${family}"], body, adapters_dir, controlnets_dir)
    print(json.dumps(checked, sort_keys=True, default=lambda b: f"{len(b)} bytes"))
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

describe.skipIf(!hasPython3)("diffusersImageRules.py", () => {
  it("ships next to localServe", () => {
    expect(fs.existsSync(rulesModule)).toBe(true);
  });

  it("imports nothing from torch or diffusers, so CI can run it", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).not.toMatch(/^\s*(import|from)\s+(torch|diffusers|transformers)/m);
  });

  it("accepts the two catalog models' model_index.json, and an SDXL finetune's", () => {
    expect(familyOf(ZIMAGE_INDEX)).toBe("Z-Image Turbo");
    expect(familyOf(CHROMA_INDEX)).toBe("Chroma");
    expect(familyOf(SDXL_INDEX)).toBe("SDXL");
  });

  it("refuses a pipeline class it does not serve", () => {
    expect(familyOf({ ...ZIMAGE_INDEX, _class_name: "StableDiffusionPipeline" })).toBe(
      'REFUSED diffusersImageServer.py serves ChromaPipeline, StableDiffusionXLPipeline, and ZImagePipeline models. This model_index.json names "StableDiffusionPipeline".',
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
      controlnet: null,
      control_image: null,
      control_scale: 1.0,
      control_invert: false,
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

  it("takes a ControlNet with its image's bytes, scale, and invert, only for SDXL, only from a folder", () => {
    const pose = Buffer.from("png").toString("base64");
    const family = "StableDiffusionXLPipeline";
    const body = { prompt: "a cat", controlnet: "scribble", control_image: pose };
    const out = JSON.parse(
      check(family, { ...body, control_scale: 0.8, control_invert: true }, null, "/c"),
    );
    expect([out.controlnet, out.control_image, out.control_scale, out.control_invert]).toEqual([
      "scribble",
      "3 bytes",
      0.8,
      true,
    ]);
    const plain = JSON.parse(check(family, body, null, "/c"));
    expect([plain.control_scale, plain.control_invert]).toEqual([1.0, false]);
    expect(check(family, { prompt: "a cat", controlnet: "scribble" }, null, "/c")).toBe(
      "ERROR 400 controlnet and control_image go together: the ControlNet's name, and the image it conditions the generation on.",
    );
    for (const lone of [{ control_scale: 1 }, { control_invert: true }]) {
      expect(check(family, { prompt: "a cat", ...lone }, null, "/c")).toBe(
        "ERROR 400 control_scale and control_invert need controlnet: they say how to apply it.",
      );
    }
    expect(check(family, body)).toBe(
      "ERROR 400 This server has no ControlNets folder. Set client.controlnetsDir in agency.json to the folder your ControlNets are in, and start the server again.",
    );
    expect(check(family, { ...body, controlnet: "../x" }, null, "/c")).toBe(
      "ERROR 400 controlnet must be a ControlNet's name: its folder in the ControlNets folder, such as \"sketch\" for sketch/. Got '../x'.",
    );
    expect(check(family, { ...body, control_scale: 5 }, null, "/c")).toBe(
      "ERROR 400 control_scale must be a number from 0 to 2.0. 1 applies it as the model card says.",
    );
    expect(check(family, { ...body, control_invert: "yes" }, null, "/c")).toBe(
      "ERROR 400 control_invert must be true or false.",
    );
    expect(check("ChromaPipeline", body, null, "/c")).toBe(
      "ERROR 400 Chroma does not take a ControlNet. Leave controlnet empty.",
    );
  });

  it("takes the control image only as base64 bytes, never as a path, up to a size", () => {
    const family = "StableDiffusionXLPipeline";
    const body = { prompt: "a cat", controlnet: "scribble" };
    expect(check(family, { ...body, control_image: "/Users/me/pose.png" }, null, "/c")).toBe(
      "ERROR 400 control_image: image is not valid base64.",
    );
    expect(check(family, { ...body, control_image: "" }, null, "/c")).toBe(
      "ERROR 400 control_image: image must be the image's bytes as base64.",
    );
    // Built in Python: 67 MB of base64 is too long for a command line.
    const tooBig = rules(`
from localServerCommon import MAX_IMAGE_BYTES, base64_length
body = {"prompt": "a cat", "controlnet": "scribble"}
body["control_image"] = "A" * (base64_length(MAX_IMAGE_BYTES) + 4)
try:
    check_request(FAMILIES["${family}"], body, None, "/c")
except RequestError as e:
    print(e)
`);
    expect(tooBig).toBe(
      "control_image: image is over 50,000,000 bytes; this server reads images up to that size.",
    );
  });

  it("fits a control image inside the output with its shape kept", () => {
    const out = rules(`
print(letterbox(400, 300, 1024, 1024))
print(letterbox(300, 400, 1024, 1024))
print(letterbox(512, 512, 1344, 768))
print(letterbox(2048, 1536, 1024, 768))
`);
    expect(out.split("\n")).toEqual([
      "(1024, 768, 0, 128)",
      "(768, 1024, 128, 0)",
      "(768, 768, 288, 0)",
      "(1024, 768, 0, 0)",
    ]);
  });

  it("refuses a configured folder that is a symlink or not a folder", () => {
    const out = rules(`
import os, tempfile
d = tempfile.mkdtemp()
os.symlink(d, d + "-link")
open(os.path.join(d, "file"), "w").close()
print(check_folder(None, "--controlnets-dir"))
print(check_folder(d, "--controlnets-dir") == d)
for bad in [d + "-link", os.path.join(d, "file")]:
    try:
        check_folder(bad, "--controlnets-dir")
    except ValueError as e:
        print(str(e).replace(bad, "X"))
`);
    expect(out.split("\n")).toEqual([
      "None",
      "True",
      "--controlnets-dir X is a symlink. Name the folder itself.",
      "--controlnets-dir X is not a folder.",
    ]);
  });

  it("lists only the ControlNets it can load: real folders with both files and no symlink inside", () => {
    const out = rules(`
import os, tempfile
d = tempfile.mkdtemp()
outside = tempfile.mkdtemp()
open(os.path.join(outside, "weights.safetensors"), "w").close()
def controlnet(name, weights_link=False, config_link=False, nested_link=False, weights=True):
    folder = os.path.join(d, name)
    os.makedirs(folder)
    if config_link:
        os.symlink(os.path.join(outside, "weights.safetensors"), os.path.join(folder, "config.json"))
    else:
        open(os.path.join(folder, "config.json"), "w").close()
    weights_path = os.path.join(folder, "diffusion_pytorch_model.safetensors")
    if weights_link:
        os.symlink(os.path.join(outside, "weights.safetensors"), weights_path)
    elif weights:
        open(weights_path, "w").close()
    if nested_link:
        os.makedirs(os.path.join(folder, "extra"))
        os.symlink(outside, os.path.join(folder, "extra", "away"))
    return folder
good = controlnet("scribble")
linked_weights = controlnet("weights-link", weights_link=True)
linked_config = controlnet("config-link", config_link=True)
nested = controlnet("nested-link", nested_link=True)
no_weights = controlnet("no-weights", weights=False)
os.symlink(good, os.path.join(d, "folder-link"))
open(os.path.join(d, "note.txt"), "w").close()
print(controlnet_names(d))
print(controlnet_names(os.path.join(d, "missing")))
print(controlnet_problem(good))
for folder in [linked_weights, linked_config, nested, no_weights, os.path.join(d, "folder-link")]:
    print(controlnet_problem(folder).replace(d, "D"))
`);
    expect(out.split("\n")).toEqual([
      "['scribble']",
      "[]",
      "None",
      "D/weights-link/diffusion_pytorch_model.safetensors is a symlink, which this server does not follow.",
      "D/config-link/config.json is a symlink, which this server does not follow.",
      "D/nested-link/extra/away is a symlink, which this server does not follow.",
      "D/no-weights has no diffusion_pytorch_model.safetensors.",
      "D/folder-link is a symlink, which this server does not follow.",
    ]);
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
print(check_folder(folder, "--adapters-dir") == folder, check_folder(None, "--adapters-dir"))
for name in ["link", "missing"]:
    try:
        check_folder(os.path.join(d, name), "--adapters-dir")
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
      "ERROR 400 style is not a setting of this server. It takes prompt, size, steps, guidance, seed, negative_prompt, output_format, response_format, n, lora, lora_scale, controlnet, control_image, control_scale, and control_invert.",
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
    expect(out.split("\n")).toEqual(["512 512 2", "512 512 2", "512 512 2"]);
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
