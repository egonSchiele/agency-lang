import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _planTraining, trainPlan, type TrainPlan } from "./agency.js";

const FAKE_PYTHON = path.resolve(import.meta.dirname, "..", "tests", "fakePython.sh");

/** The model_index.json of an SDXL checkpoint, which marks a directory as
 *  an image model. */
const SDXL_INDEX = {
  _class_name: "StableDiffusionXLPipeline",
  force_zeros_for_empty_prompt: true,
  scheduler: ["diffusers", "EulerDiscreteScheduler"],
  text_encoder: ["transformers", "CLIPTextModel"],
  text_encoder_2: ["transformers", "CLIPTextModelWithProjection"],
  tokenizer: ["transformers", "CLIPTokenizer"],
  tokenizer_2: ["transformers", "CLIPTokenizer"],
  unet: ["diffusers", "UNet2DConditionModel"],
  vae: ["diffusers", "AutoencoderKL"],
};

// Each test runs in a fresh folder whose agency.json points the Python at
// the fake trainer, so the Python comes from config, as it does for a user.
describe("planning and running a training run", () => {
  const savedCwd = process.cwd();
  let dir: string;
  let log: string;

  function plan(outPath = "sketch.safetensors", base = "./model"): TrainPlan {
    return _planTraining(
      "images",
      "sketch",
      base,
      outPath,
      20,
      16,
      0.0001,
      512,
      false,
      1,
      ["sketch, a cat"],
      10,
    );
  }

  /** A folder that looks like a downloaded diffusers model: its
   *  model_index.json and one component's weights. */
  function diffusersDir(name: string, index: Record<string, unknown>): void {
    fs.mkdirSync(path.join(dir, name, "unet"), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "model_index.json"), JSON.stringify(index));
    fs.writeFileSync(path.join(dir, name, "unet", "diffusion_pytorch_model.safetensors"), "");
  }

  function runs(): string[][] {
    return fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lora-plan-")));
    fs.mkdirSync(path.join(dir, "images"));
    fs.writeFileSync(path.join(dir, "images", "a.png"), "png");
    diffusersDir("model", SDXL_INDEX);
    fs.writeFileSync(
      path.join(dir, "agency.json"),
      JSON.stringify({ client: { mlx: { python: FAKE_PYTHON } } }),
    );
    log = path.join(dir, "runs.log");
    process.env.FAKE_TRAINER_LOG = log;
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    delete process.env.FAKE_TRAINER_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("plans with the real paths and an estimate, and runs nothing", () => {
    expect(plan()).toEqual({
      imagesDir: path.join(dir, "images"),
      outPath: path.join(dir, "sketch.safetensors"),
      base: "./model",
      trigger: "sketch",
      steps: 20,
      rank: 16,
      learningRate: 0.0001,
      resolution: 512,
      flip: false,
      seed: 1,
      samplePrompts: ["sketch, a cat"],
      sampleEvery: 10,
      estimatedMinutes: 0.3,
    });
    expect(runs()).toEqual([]);
  });

  it("refuses a base model that is not an image model", () => {
    diffusersDir("not-a-model", { ...SDXL_INDEX, _class_name: "SomeOtherPipeline" });
    expect(() => plan("sketch.safetensors", "./not-a-model")).toThrow("is not an image model");
  });

  it("refuses an adapter that exists, and a linked partial file or samples folder", () => {
    fs.writeFileSync(path.join(dir, "old.safetensors"), "x");
    expect(() => plan("old.safetensors")).toThrow("already exists");
    fs.symlinkSync(os.homedir(), path.join(dir, "a.safetensors.partial"));
    expect(() => plan("a.safetensors")).toThrow("is a symlink");
    fs.symlinkSync(os.homedir(), path.join(dir, "b-samples"));
    expect(() => plan("b.safetensors")).toThrow("is a symlink");
    expect(runs()).toEqual([]);
  });

  it("runs the configured Python on the planned paths", async () => {
    const planned = plan();
    const trained = await trainPlan(planned, undefined);
    expect(trained).toMatchObject({
      path: planned.outPath,
      images: 4,
      steps: 20,
    });
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toEqual(
      expect.arrayContaining([
        `--images=${planned.imagesDir}`,
        `--out=${planned.outPath}`,
        `--model=${path.join(dir, "model")}`,
        `--sample-prompts-json=["sketch, a cat"]`,
      ]),
    );
  });

  it("checks the paths again after approval and runs nothing when one changed", async () => {
    const planned = plan();
    fs.symlinkSync(os.homedir(), path.join(dir, "sketch-samples"));
    await expect(trainPlan(planned, undefined)).rejects.toThrow("is a symlink");
    expect(runs()).toEqual([]);
  });
});
