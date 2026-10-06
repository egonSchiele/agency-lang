import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { fixedPath, resolveUnder, stat, remove } from "agency-lang/host-lib/nodeFiles.js";

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
  /** The folder holding the image server's `diffusersImageRules.py`, whose
   *  family table the trainer checks the base model against. */
  rulesDir: string;
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
  | { event: "start"; images: number }
  | { event: "cached"; images: number }
  | { event: "step"; step: number; loss: number; secondsPerStep: number }
  | { event: "sample"; path: string }
  | { event: "done"; path: string; minutes: number };

export type Trained = { path: string; minutes: number; samples: string[]; images: number };

/** A training run that did not finish: the trainer refused its arguments,
 *  the Python was missing, or the run died. The message is the trainer's
 *  own last words. */
export class TrainError extends Error {}

/** The trainer's command line, after the Python. Every value goes in the
 *  `--name=value` form and the prompts go as one JSON array, so argparse
 *  never reads a caller's string as a flag: a prompt of "--out /elsewhere"
 *  stays a prompt. */
export function trainerArgv(args: TrainArgs): string[] {
  const out = [
    trainerScript(),
    `--model=${args.modelDir}`,
    `--images=${args.imagesDir}`,
    `--trigger=${args.trigger}`,
    `--out=${args.outPath}`,
    `--rules-dir=${args.rulesDir}`,
    `--base-name=${args.baseName}`,
    `--steps=${args.steps}`,
    `--rank=${args.rank}`,
    `--lr=${args.learningRate}`,
    `--resolution=${args.resolution}`,
    `--seed=${args.seed}`,
    `--sample-every=${args.sampleEvery}`,
    `--sample-prompts-json=${JSON.stringify(args.samplePrompts)}`,
  ];
  if (args.flip) {
    out.push("--flip");
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

/** Runs the trainer, sending each event to `onEvent`, and resolves once
 *  it exits. Rejects with the trainer's stderr on a
 *  non-zero exit, or when the signal aborts. A signal that is already
 *  aborted starts nothing: an abort listener never fires for it. */
function runTrainer(
  args: TrainArgs,
  onEvent: (event: TrainEvent) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TrainError("training was cancelled"));
      return;
    }
    const child = spawn(args.python, trainerArgv(args), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    let pending = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseEvent(line);
        if (event !== null) {
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
      resolve();
    });
  });
}

/** Removes what a run that did not succeed left behind: the partial
 *  file, and the adapter itself when the trainer finished writing it but
 *  the run was cancelled on the way out. The trainer refuses an `outPath`
 *  that already exists, so an adapter there after a `done` event is this
 *  run's own. */
function removeLeftovers(outPath: string, wroteAdapter: boolean): void {
  const targets = wroteAdapter ? [`${outPath}.partial`, outPath] : [`${outPath}.partial`];
  for (const target of targets) {
    const located = fixedPath(target);
    if (stat(located.root, located.target) !== null) {
      remove(located.root, located.target);
    }
  }
}

/** Trains, streaming progress to `onEvent`, and returns the adapter's path,
 *  the sample grids, and how many images it trained on. A cancelled or
 *  failed run leaves neither a `.partial` file nor an adapter. */
export async function runTraining(
  args: TrainArgs,
  onEvent: (event: TrainEvent) => void,
  signal: AbortSignal | undefined,
): Promise<Trained> {
  const events: TrainEvent[] = [];
  try {
    await runTrainer(
      args,
      (event) => {
        events.push(event);
        onEvent(event);
      },
      signal,
    );
  } catch (err) {
    removeLeftovers(
      args.outPath,
      events.some((event) => event.event === "done"),
    );
    throw err;
  }
  const done = events.find((event) => event.event === "done");
  const start = events.find((event) => event.event === "start");
  if (
    done === undefined ||
    done.event !== "done" ||
    start === undefined ||
    start.event !== "start"
  ) {
    removeLeftovers(args.outPath, false);
    throw new TrainError("the trainer exited without writing the adapter");
  }
  const samples = events.flatMap((event) => (event.event === "sample" ? [event.path] : []));
  const located = fixedPath(done.path);
  return {
    path: resolveUnder(located.root, located.target),
    minutes: done.minutes,
    samples,
    images: start.images,
  };
}
