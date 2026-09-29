import * as path from "node:path";
import { getRuntimeContext } from "agency-lang/runtime";
import { _realTarget, fixedPath, stat } from "agency-lang/stdlib-lib/contained.js";
import { configuredPython } from "agency-lang/stdlib-lib/localPython.js";
import {
  _resolveModel,
  _findDownloadedServedModel,
  _localModelKindOf,
} from "agency-lang/stdlib-lib/localModels.js";
import { isServedUri, parseServedUri } from "agency-lang/stdlib-lib/modelBackend.js";
import { estimateTraining, runTraining, type TrainArgs, type Trained } from "./train.js";
import { readSafetensorsHeader } from "./safetensors.js";

/** The functions index.agency calls. Each check throws before any
 *  interrupt is raised; after approval the same real spellings are used. */

/** Everything `trainLora` knows before it raises its effect: the real
 *  paths, the base model's directory, and the trainer's estimate. */
export type TrainPlan = {
  args: TrainArgs;
  imagesDir: string;
  outPath: string;
  images: number;
  estimatedMinutes: number;
};

/** The directory of a downloaded image model, by catalog name, URI, or
 *  path. Throws when it is not an image model or not downloaded. */
function baseModelDir(base: string): string {
  const kind = _localModelKindOf(base);
  if (kind !== null && kind !== "image") {
    throw new Error(
      `lora: "${base}" is ${kind === "embedding" ? "an" : "a"} ${kind} model, not an image model.`,
    );
  }
  const resolved = _resolveModel(base);
  if (isServedUri(resolved.target)) {
    const { backend, repo, revision } = parseServedUri(resolved.target);
    const found = _findDownloadedServedModel(backend, repo, "", revision);
    if (found === null) {
      throw new Error(
        `lora: ${base} is not downloaded. Run:\n  agency local download ${resolved.target}`,
      );
    }
    return found.path;
  }
  return path.resolve(resolved.target);
}

export async function _planTraining(
  imagesDir: string,
  trigger: string,
  base: string,
  outPath: string,
  steps: number,
  rank: number,
  learningRate: number,
  resolution: number,
  flip: boolean,
  seed: number,
  samplePrompts: string[],
  sampleEvery: number,
  pythonPath: string,
): Promise<TrainPlan> {
  const realImages = _realTarget(imagesDir);
  const realOut = _realTarget(outPath);
  const modelDir = baseModelDir(base);
  const args: TrainArgs = {
    python: pythonPath === "" ? configuredPython() : pythonPath,
    modelDir,
    baseName: base,
    imagesDir: realImages,
    trigger,
    outPath: realOut,
    steps,
    rank,
    learningRate,
    resolution,
    flip,
    seed,
    samplePrompts,
    sampleEvery,
  };
  const estimate = await estimateTraining(args);
  return {
    args,
    imagesDir: realImages,
    outPath: realOut,
    images: estimate.images,
    estimatedMinutes: estimate.estimatedMinutes,
  };
}

export async function _train(
  plan: TrainPlan,
): Promise<Trained & { images: number; steps: number }> {
  const { ctx, stack } = getRuntimeContext();
  // The spellings the approver saw, checked again for a link that appeared
  // while the prompt was pending.
  const images = fixedPath(plan.imagesDir);
  if (stat(images.root, images.target)?.isDirectory() !== true) {
    throw new Error(`lora: ${plan.imagesDir} is not a directory.`);
  }
  fixedPath(plan.outPath);
  const trained = await runTraining(plan.args, () => undefined, ctx.getAbortSignal(stack));
  return { ...trained, images: plan.images, steps: plan.args.steps };
}

export type LoraInfo = {
  base: string;
  trigger: string;
  rank: number;
  steps: number;
  sizeBytes: number;
};

export async function _loraInfo(spelling: string): Promise<LoraInfo> {
  const header = await readSafetensorsHeader(spelling);
  const { base, trigger, rank, step } = header.metadata;
  if (base === undefined || trigger === undefined || rank === undefined || step === undefined) {
    throw new Error(
      `${spelling} carries no training metadata (base, trigger, rank, step). It was not written by this trainer.`,
    );
  }
  return { base, trigger, rank: Number(rank), steps: Number(step), sizeBytes: header.sizeBytes };
}
