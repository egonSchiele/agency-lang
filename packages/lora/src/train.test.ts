import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTraining, trainerScript, type TrainArgs, type TrainEvent } from "./train.js";

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
      rulesDir: path.join(dir, "rules"),
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

  it("streams events, returns the adapter and its samples, and leaves no partial file", async () => {
    const seen: TrainEvent[] = [];
    const trained = await runTraining(args, (event) => seen.push(event), undefined);
    expect(trained).toEqual({
      path: args.outPath,
      minutes: 0.2,
      samples: [path.join(dir, "step_0020.png")],
      images: 4,
    });
    expect(seen.map((event) => event.event)).toEqual(["start", "cached", "step", "sample", "done"]);
    expect(fs.existsSync(args.outPath)).toBe(true);
    expect(fs.existsSync(`${args.outPath}.partial`)).toBe(false);
  });

  it("reports the trainer's refusal as the error", async () => {
    process.env.FAKE_TRAINER = "refuse";
    await expect(runTraining(args, () => undefined, undefined)).rejects.toThrow(
      "steps must be from 1 to 20000. Got 0.",
    );
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

  it("starts nothing when the run was cancelled before it began", async () => {
    const log = path.join(dir, "runs.log");
    process.env.FAKE_TRAINER_LOG = log;
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(runTraining(args, () => undefined, controller.signal)).rejects.toThrow(
        "training was cancelled",
      );
    } finally {
      delete process.env.FAKE_TRAINER_LOG;
    }
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(args.outPath)).toBe(false);
  });

  it("removes the adapter when the run is cancelled after writing it", async () => {
    process.env.FAKE_TRAINER = "hang-after-done";
    const controller = new AbortController();
    const run = runTraining(
      args,
      (event) => {
        if (event.event === "done") {
          controller.abort();
        }
      },
      controller.signal,
    );
    await expect(run).rejects.toThrow("training was cancelled");
    expect(fs.existsSync(args.outPath)).toBe(false);
    expect(fs.existsSync(`${args.outPath}.partial`)).toBe(false);
  });

  it("says what is missing when the Python cannot be run", async () => {
    await expect(
      runTraining({ ...args, python: path.join(dir, "no-python") }, () => undefined, undefined),
    ).rejects.toThrow(/could not be run .* trainLora needs the Python agency local serve uses/);
  });
});
