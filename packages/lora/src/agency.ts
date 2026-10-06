import * as path from "node:path";
import { currentRun } from "agency-lang/runtime";
import { _realTarget, fixedPath, resolveUnder, stat } from "agency-lang/host-lib/nodeFiles.js";
import { configuredPython, serverRulesDir } from "agency-lang/stdlib-lib/localPython.js";
import {
  _resolveModel,
  _findDownloadedServedModel,
  _localModelKindOf,
} from "agency-lang/stdlib-lib/localModels.js";
import { isServedUri, parseServedUri, readModelJson } from "agency-lang/stdlib-lib/modelBackend.js";
import { estimateMinutes } from "./estimate.js";
import { runTraining, type Trained } from "./train.js";
import { readSafetensorsHeader } from "./safetensors.js";

/** The functions index.agency calls. Nothing here runs a process or reads
 *  the images folder before `lora::train` is approved. The plan holds one
 *  copy of every value, and `_train` builds the trainer's arguments from
 *  the same copy it checks, so the values that run are the values that
 *  were checked. */

/** Everything `trainLora` knows before it raises its effect: the real
 *  spellings of the two paths, the settings, and the estimate. The Python
 *  and the base model's directory are not in it; `_train` works them out
 *  again, so a checkpoint cannot choose them. */
export type TrainPlan = {
  imagesDir: string;
  outPath: string;
  base: string;
  trigger: string;
  steps: number;
  rank: number;
  learningRate: number;
  resolution: number;
  flip: boolean;
  seed: number;
  samplePrompts: string[];
  sampleEvery: number;
  estimatedMinutes: number;
};

/** The directory of a downloaded image model, by catalog name, URI, or
 *  path. Throws when it is not an image model or not downloaded. The
 *  trainer then checks its model_index.json against the image server's
 *  family table before loading it. */
/** The one pipeline the trainer trains. */
const SDXL_PIPELINE = "StableDiffusionXLPipeline";

function baseModelDir(base: string): string {
  const kind = _localModelKindOf(base);
  if (kind !== null && kind !== "image") {
    throw new Error(
      `lora: "${base}" is ${kind === "embedding" ? "an" : "a"} ${kind} model, not an image model.`,
    );
  }
  const resolved = _resolveModel(base);
  let dir = path.resolve(resolved.target);
  if (isServedUri(resolved.target)) {
    const { backend, repo, revision } = parseServedUri(resolved.target);
    const found = _findDownloadedServedModel(backend, repo, "", revision);
    if (found === null) {
      throw new Error(
        `lora: ${base} is not downloaded. Run:\n  agency local download ${resolved.target}`,
      );
    }
    dir = found.path;
  }
  if (kind === null) {
    throw new Error(`lora: ${base} is not an image model: ${dir} has no model_index.json for one.`);
  }
  // Any diffusers folder counts as an image model, but the trainer only
  // trains SDXL. Saying so here refuses the rest before anyone is asked to
  // approve a run; the trainer checks the family table again after.
  const pipeline = readModelJson(dir, "model_index.json")?._class_name;
  if (pipeline !== SDXL_PIPELINE) {
    throw new Error(
      `lora: ${base} is a ${String(pipeline)} model. lora trains SDXL models only (${SDXL_PIPELINE}).`,
    );
  }
  return dir;
}

/** Throws when `spelling` is a symlink. It is checked below its real
 *  parent, so a link anywhere in the parent's spelling is refused too. */
function refuseLink(spelling: string): void {
  const located = fixedPath(spelling);
  resolveUnder(located.root, located.target);
}

/** The folder the trainer writes sample grids into, beside the adapter.
 *  The same name as `samples_dir` in trainer/rules.py. */
function samplesDir(outPath: string): string {
  return path.join(path.dirname(outPath), `${path.basename(outPath, ".safetensors")}-samples`);
}

/** The paths the run writes or reads, checked with nothing followed: the
 *  images folder must be a directory, the adapter must not exist yet, and
 *  neither `<out>.partial` nor the samples folder may be a link. */
function checkPaths(imagesDir: string, outPath: string): void {
  const images = fixedPath(imagesDir);
  if (stat(images.root, images.target)?.isDirectory() !== true) {
    throw new Error(`lora: ${imagesDir} is not a directory.`);
  }
  if (!outPath.endsWith(".safetensors")) {
    throw new Error(`lora: ${outPath} must end in .safetensors.`);
  }
  const out = fixedPath(outPath);
  refuseLink(outPath);
  if (stat(out.root, out.target) !== null) {
    throw new Error(`lora: ${outPath} already exists. Remove it first, or write elsewhere.`);
  }
  refuseLink(`${outPath}.partial`);
  refuseLink(samplesDir(outPath));
}

export function _planTraining(
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
): TrainPlan {
  const realImages = _realTarget(imagesDir);
  const realOut = _realTarget(outPath);
  checkPaths(realImages, realOut);
  baseModelDir(base);
  return {
    imagesDir: realImages,
    outPath: realOut,
    base,
    trigger,
    steps,
    rank,
    learningRate,
    resolution,
    flip,
    seed,
    samplePrompts,
    sampleEvery,
    estimatedMinutes: estimateMinutes(steps, resolution, samplePrompts, sampleEvery),
  };
}

/** Runs an approved plan. The paths are checked again, for a link that
 *  appeared while the prompt was pending, and the trainer's arguments are
 *  built from the same fields that were checked. */
export async function trainPlan(
  plan: TrainPlan,
  signal: AbortSignal | undefined,
): Promise<Trained & { steps: number }> {
  checkPaths(plan.imagesDir, plan.outPath);
  const trained = await runTraining(
    {
      python: configuredPython(),
      modelDir: baseModelDir(plan.base),
      rulesDir: serverRulesDir(),
      baseName: plan.base,
      imagesDir: plan.imagesDir,
      trigger: plan.trigger,
      outPath: plan.outPath,
      steps: plan.steps,
      rank: plan.rank,
      learningRate: plan.learningRate,
      resolution: plan.resolution,
      flip: plan.flip,
      seed: plan.seed,
      samplePrompts: plan.samplePrompts,
      sampleEvery: plan.sampleEvery,
    },
    () => undefined,
    signal,
  );
  return { ...trained, steps: plan.steps };
}

export async function _train(plan: TrainPlan): Promise<Trained & { steps: number }> {
  const { ctx, stack } = currentRun();
  return trainPlan(plan, ctx.getAbortSignal(stack));
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
