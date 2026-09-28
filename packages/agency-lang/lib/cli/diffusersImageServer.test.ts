import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DIFFUSERS_VERSION, imageServerScript } from "./localServe.js";

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

// The model_index.json files of the two catalog models, as downloaded.
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
 *  not Python's. */
function check(family: "ZImagePipeline" | "ChromaPipeline", body: unknown): string {
  return rules(`
import json
body = json.loads(${JSON.stringify(JSON.stringify(body))})
try:
    print(json.dumps(check_request(FAMILIES["${family}"], body), sort_keys=True))
except RequestError as e:
    print("ERROR", e.status, e)
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

  it("accepts the two catalog models' model_index.json", () => {
    expect(familyOf(ZIMAGE_INDEX)).toBe("Z-Image Turbo");
    expect(familyOf(CHROMA_INDEX)).toBe("Chroma");
  });

  it("refuses a pipeline class it does not serve", () => {
    expect(familyOf({ ...ZIMAGE_INDEX, _class_name: "StableDiffusionPipeline" })).toBe(
      'REFUSED diffusersImageServer.py serves ChromaPipeline and ZImagePipeline models. This model_index.json names "StableDiffusionPipeline".',
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
    });
    const chroma = JSON.parse(check("ChromaPipeline", { prompt: "a cat", seed: 7 }));
    expect([chroma.steps, chroma.guidance]).toEqual([40, 3.0]);
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

  it("refuses a field it does not know, naming the ones it takes", () => {
    expect(check("ZImagePipeline", { prompt: "a cat", style: "vivid" })).toBe(
      "ERROR 400 style is not a setting of this server. It takes prompt, size, steps, guidance, seed, negative_prompt, output_format, response_format, and n.",
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
    expect(out.split("\n")).toEqual(["512 512 2", "512 512 2"]);
  });

  it("pins the same diffusers version as localServe.ts", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).toContain(`DIFFUSERS_VERSION = "${DIFFUSERS_VERSION}"`);
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
