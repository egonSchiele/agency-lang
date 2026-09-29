import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  estimateTraining,
  runTraining,
  trainerScript,
  type TrainArgs,
  type TrainEvent,
} from "./train.js";

const FAKE_PYTHON = path.resolve(import.meta.dirname, "..", "tests", "fakePython.sh");

describe("the trainer runner", () => {
  let dir: string;
  let args: TrainArgs;
  const savedMode = process.env.FAKE_TRAINER;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lora-")));
    fs.mkdirSync(path.join(dir, "images"));
    args = {
      python: FAKE_PYTHON,
      modelDir: path.join(dir, "model"),
      baseName: "noobai-xl",
      imagesDir: path.join(dir, "images"),
      trigger: "sketch",
      outPath: path.join(dir, "sketch.safetensors"),
      steps: 20,
      rank: 16,
      learningRate: 0.0001,
      resolution: 512,
      flip: true,
      seed: 1,
      samplePrompts: ["sketch, a cat"],
      sampleEvery: 10,
    };
    delete process.env.FAKE_TRAINER;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedMode === undefined) {
      delete process.env.FAKE_TRAINER;
    } else {
      process.env.FAKE_TRAINER = savedMode;
    }
  });

  it("ships the trainer script", () => {
    expect(fs.existsSync(trainerScript())).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(trainerScript()), "rules.py"))).toBe(true);
  });

  it("reads the estimate the trainer prints without training", async () => {
    expect(await estimateTraining(args)).toEqual({ images: 4, steps: 20, estimatedMinutes: 0.3 });
    expect(fs.existsSync(args.outPath)).toBe(false);
  });

  it("streams events, returns the adapter and its samples, and leaves no partial file", async () => {
    const seen: TrainEvent[] = [];
    const trained = await runTraining(args, (event) => seen.push(event), undefined);
    expect(trained).toEqual({
      path: args.outPath,
      minutes: 0.2,
      samples: [path.join(dir, "step_0020.png")],
    });
    expect(seen.map((event) => event.event)).toEqual([
      "estimate",
      "cached",
      "step",
      "sample",
      "done",
    ]);
    expect(fs.existsSync(args.outPath)).toBe(true);
    expect(fs.existsSync(`${args.outPath}.partial`)).toBe(false);
  });

  it("reports the trainer's refusal as the error", async () => {
    process.env.FAKE_TRAINER = "refuse";
    await expect(estimateTraining(args)).rejects.toThrow("steps must be from 1 to 20000. Got 0.");
  });

  it("reports a run that died with its last words, and removes the partial file", async () => {
    process.env.FAKE_TRAINER = "die";
    await expect(runTraining(args, () => undefined, undefined)).rejects.toThrow(
      "the GPU ran out of memory",
    );
    expect(fs.existsSync(`${args.outPath}.partial`)).toBe(false);
  });

  it("kills the run on abort and removes the partial file", async () => {
    process.env.FAKE_TRAINER = "hang";
    const controller = new AbortController();
    const run = runTraining(
      args,
      (event) => {
        if (event.event === "cached") {
          controller.abort();
        }
      },
      controller.signal,
    );
    await expect(run).rejects.toThrow("training was cancelled");
    expect(fs.existsSync(`${args.outPath}.partial`)).toBe(false);
  });

  it("says what is missing when the Python cannot be run", async () => {
    await expect(
      estimateTraining({ ...args, python: path.join(dir, "no-python") }),
    ).rejects.toThrow(/could not be run .* trainLora needs the Python agency local serve uses/);
  });
});
