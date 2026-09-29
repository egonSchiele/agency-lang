import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { fixedPath, resolveUnder, stat, remove } from "agency-lang/stdlib-lib/contained.js";

/** Runs the trainer, `trainer/train_lora_sdxl.py`, as a child process and
 *  turns its JSON lines into events and a result. This is the one place a
 *  process is spawned, its output parsed, and its abort handled. */

/** The script shipped in the package, in `trainer/` beside `src/`. This
 *  module runs from `dist/src/` when built and from `src/` under the test
 *  runner, so the package root is one or two levels up. */
export function trainerScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = path.basename(path.dirname(here)) === "dist";
  const root = built ? path.join(here, "..", "..") : path.join(here, "..");
  return path.join(root, "trainer", "train_lora_sdxl.py");
}

export type TrainArgs = {
  python: string;
  modelDir: string;
  /** The base model as the caller named it, written into the adapter's
   *  metadata so loraInfo says "noobai-xl", not a cache directory's hash. */
  baseName: string;
  imagesDir: string;
  trigger: string;
  outPath: string;
  steps: number;
  rank: number;
  learningRate: number;
  resolution: number;
  flip: boolean;
  seed: number;
  samplePrompts: string[];
  sampleEvery: number;
};

export type TrainEvent =
  | { event: "estimate"; images: number; steps: number; estimatedMinutes: number }
  | { event: "cached"; images: number }
  | { event: "step"; step: number; loss: number; secondsPerStep: number }
  | { event: "sample"; path: string }
  | { event: "done"; path: string; minutes: number };

export type Estimate = { images: number; steps: number; estimatedMinutes: number };

export type Trained = { path: string; minutes: number; samples: string[] };

/** A training run that did not finish: the trainer refused its arguments,
 *  the Python was missing, or the run died. The message is the trainer's
 *  own last words. */
export class TrainError extends Error {}

function argv(args: TrainArgs): string[] {
  const out = [
    trainerScript(),
    "--model",
    args.modelDir,
    "--images",
    args.imagesDir,
    "--trigger",
    args.trigger,
    "--out",
    args.outPath,
    "--base-name",
    args.baseName,
    "--steps",
    String(args.steps),
    "--rank",
    String(args.rank),
    "--lr",
    String(args.learningRate),
    "--resolution",
    String(args.resolution),
    "--seed",
    String(args.seed),
    "--sample-every",
    String(args.sampleEvery),
  ];
  if (args.flip) {
    out.push("--flip");
  }
  if (args.samplePrompts.length > 0) {
    out.push("--sample-prompts", ...args.samplePrompts);
  }
  return out;
}

/** One JSON line as an event, or null for a line that is not one. */
function parseEvent(line: string): TrainEvent | null {
  try {
    const parsed = JSON.parse(line) as TrainEvent;
    return typeof parsed === "object" && parsed !== null && "event" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** Runs the trainer with the given extra flags, sending each event to
 *  `onEvent`, and resolves with every event once it exits. Rejects with
 *  the trainer's stderr on a non-zero exit, or with the abort reason. */
function runTrainer(
  args: TrainArgs,
  extra: string[],
  onEvent: (event: TrainEvent) => void,
  signal: AbortSignal | undefined,
): Promise<TrainEvent[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.python, [...argv(args), ...extra], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    const events: TrainEvent[] = [];
    let pending = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseEvent(line);
        if (event !== null) {
          events.push(event);
          onEvent(event);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(
        new TrainError(
          `${args.python} could not be run (${err.message}). trainLora needs the Python agency local serve uses, with torch and diffusers installed.`,
        ),
      );
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new TrainError("training was cancelled"));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-5).join("\n");
        reject(new TrainError(detail === "" ? `the trainer exited with ${code}` : detail));
        return;
      }
      resolve(events);
    });
  });
}

/** Checks the arguments and reads the captions without loading a model,
 *  and returns the estimate. What runs before the effect is raised. */
export async function estimateTraining(args: TrainArgs): Promise<Estimate> {
  const events = await runTrainer(args, ["--estimate-only"], () => undefined, undefined);
  const estimate = events.find((event) => event.event === "estimate");
  if (estimate === undefined || estimate.event !== "estimate") {
    throw new TrainError("the trainer printed no estimate");
  }
  return {
    images: estimate.images,
    steps: estimate.steps,
    estimatedMinutes: estimate.estimatedMinutes,
  };
}

/** Removes the partial file a killed run leaves, if there is one. */
function removePartial(outPath: string): void {
  const partial = `${outPath}.partial`;
  const located = fixedPath(partial);
  if (stat(located.root, located.target) !== null) {
    remove(located.root, located.target);
  }
}

/** Trains, streaming progress to `onEvent`, and returns the adapter's path
 *  and the sample grids. A cancelled or failed run leaves no `.partial`. */
export async function runTraining(
  args: TrainArgs,
  onEvent: (event: TrainEvent) => void,
  signal: AbortSignal | undefined,
): Promise<Trained> {
  let events: TrainEvent[];
  try {
    events = await runTrainer(args, [], onEvent, signal);
  } catch (err) {
    removePartial(args.outPath);
    throw err;
  }
  const done = events.find((event) => event.event === "done");
  if (done === undefined || done.event !== "done") {
    removePartial(args.outPath);
    throw new TrainError("the trainer exited without writing the adapter");
  }
  const samples = events.flatMap((event) => (event.event === "sample" ? [event.path] : []));
  const located = fixedPath(done.path);
  return { path: resolveUnder(located.root, located.target), minutes: done.minutes, samples };
}
