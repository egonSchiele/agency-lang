import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { trainerArgv, trainerScript, type TrainArgs } from "./train.js";

// Runs the real trainer's parse_args on the command line trainerArgv
// builds. Importing the script needs only argparse and rules.py, no torch.
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

function parsed(args: TrainArgs): Record<string, unknown> {
  const [script, ...argv] = trainerArgv(args);
  const code = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import train_lora_sdxl as t",
    "print(json.dumps(vars(t.parse_args(json.loads(sys.argv[2])))))",
  ].join("\n");
  const run = spawnSync("python3", ["-c", code, path.dirname(script), JSON.stringify(argv)], {
    stdio: "pipe",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout.toString()) as Record<string, unknown>;
}

describe.skipIf(!hasPython3)("the trainer's command line", () => {
  const args: TrainArgs = {
    python: "python3",
    modelDir: "/models/noobai",
    rulesDir: "/rules",
    baseName: "noobai-xl",
    imagesDir: "/work/drawings",
    trigger: "pen and ink",
    outPath: "/work/adapters/sketch.safetensors",
    steps: 20,
    rank: 16,
    learningRate: 0.0001,
    resolution: 512,
    flip: true,
    seed: 1,
    samplePrompts: ["a cat"],
    sampleEvery: 10,
  };

  it("starts with the shipped script", () => {
    expect(trainerArgv(args)[0]).toBe(trainerScript());
  });

  it("gives the parser every value as written", () => {
    expect(parsed(args)).toMatchObject({
      model: "/models/noobai",
      images: "/work/drawings",
      trigger: "pen and ink",
      out: "/work/adapters/sketch.safetensors",
      rules_dir: "/rules",
      base_name: "noobai-xl",
      steps: 20,
      rank: 16,
      lr: 0.0001,
      resolution: 512,
      seed: 1,
      sample_every: 10,
      flip: true,
      sample_prompts: ["a cat"],
    });
  });

  it("never reads a prompt or the trigger as a flag", () => {
    const hostile = [
      "a cat",
      "--images",
      "/Users/me/private",
      "--out",
      "/elsewhere/x.safetensors",
      "--model=/elsewhere/model",
    ];
    const result = parsed({
      ...args,
      trigger: "--out=/elsewhere/y.safetensors",
      samplePrompts: hostile,
    });
    expect(result).toMatchObject({
      images: "/work/drawings",
      out: "/work/adapters/sketch.safetensors",
      model: "/models/noobai",
      trigger: "--out=/elsewhere/y.safetensors",
      sample_prompts: hostile,
    });
  });
});
