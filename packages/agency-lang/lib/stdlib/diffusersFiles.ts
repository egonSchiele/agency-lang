import type { HubFile } from "./hubClient.js";

/** Which files of a diffusers repo to download. A diffusers repo often holds
 *  more than the pipeline reads: a single-file copy of the transformer at
 *  the top (17.8 GB for Chroma1-HD), `.bin` copies of each weight, fp16
 *  variants, and README images. The pipeline reads `model_index.json` and
 *  the component folders it names, and Agency's image server loads only
 *  `.safetensors` weights. */

export const MODEL_INDEX = "model_index.json";

/** Weight formats the image server never loads. `.bin` and `.ckpt` load
 *  through Python's pickle, which runs code. */
const OTHER_WEIGHTS = /\.(bin|pt|pth|ckpt|onnx|onnx_data|msgpack|h5|pb|gguf)$/;

/** A variant copy, such as `model.fp16.safetensors` or
 *  `model.fp16-00001-of-00002.safetensors`, or its index. */
const VARIANT = /\.(fp16|bf16|fp32)[.-]/;

export function hasModelIndex(files: HubFile[]): boolean {
  return files.some((f) => f.path === MODEL_INDEX);
}

/** The component folders a model_index.json names: every key that does not
 *  start with `_` and names a library and class. `[null, null]` is an empty
 *  slot with no folder. */
export function componentFolders(modelIndex: unknown): string[] {
  if (modelIndex === null || typeof modelIndex !== "object" || Array.isArray(modelIndex)) {
    throw new Error(`${MODEL_INDEX} is not a JSON object.`);
  }
  return Object.entries(modelIndex as Record<string, unknown>)
    .filter(([key, value]) => !key.startsWith("_") && Array.isArray(value) && value[0] !== null)
    .map(([key]) => key);
}

/** The files to download: `model_index.json`, and the files directly inside
 *  each named component folder, keeping only `.safetensors` weights with no
 *  variant infix. Throws, naming the component, when a folder has weights
 *  but none of them are `.safetensors`, since the server could never load
 *  it. */
export function diffusersFiles(repo: string, files: HubFile[], modelIndex: unknown): HubFile[] {
  const folders = componentFolders(modelIndex);
  const kept = files.filter((f) => f.path === MODEL_INDEX);
  for (const folder of folders) {
    const inside = files.filter((f) => {
      const parts = f.path.split("/");
      return parts.length === 2 && parts[0] === folder;
    });
    const fileName = (f: HubFile) => f.path.slice(folder.length + 1);
    const isSafetensors = (f: HubFile) => fileName(f).endsWith(".safetensors");
    const isWeight = (f: HubFile) => isSafetensors(f) || OTHER_WEIGHTS.test(fileName(f));
    const keep = inside.filter(
      (f) => !VARIANT.test(fileName(f)) && !OTHER_WEIGHTS.test(fileName(f)),
    );
    if (inside.some(isWeight) && !keep.some(isSafetensors)) {
      throw new Error(
        `${repo}'s ${folder} has no .safetensors weights. Agency's image server loads only ` +
          ".safetensors, so this model cannot be served.",
      );
    }
    kept.push(...keep);
  }
  return kept;
}
