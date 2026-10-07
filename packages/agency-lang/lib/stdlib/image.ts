import * as path from "node:path";
import * as smoltalk from "smoltalk";
import { currentRun, type Run } from "../runtime/asyncContext.js";
import { success, failure, type ResultValue } from "../runtime/result.js";
import { recordUsage, meteredDispatch } from "../runtime/recordPaidUsage.js";
import { classifySource } from "./thread.js";
// One image type surface — imported from llmClient.ts, not smoltalk directly.
import type { ImageConfig, ImageGenResult, ImageInput, ImageRef } from "../runtime/llmClient.js";
import { mlxBaseUrl } from "./mlxServerModels.js";
import { checkLocalImageArgs, localImageSettings, type LocalGeneratedImage } from "./mlxImage.js";
import { explainNoServer } from "./localRequest.js";
import { PROMPT_PREVIEW_MAX } from "../statelogClient.js";
import type { Host } from "../host/host.js";
import { approvedFileBytes } from "./approvedPath.js";
import { encodeBase64 } from "./base64.js";
import { MAX_IMAGE_BYTES } from "./vision.js";
import {
  IMAGE_MIME_TYPES,
  LOCAL_IMAGE_FIELDS,
  checkedImageFile,
  fieldValue,
  isRemoteSource,
  referenceCount,
  type LocalImageInputs,
} from "./localImageInputs.js";
import { DEFAULT_IMAGE_MODEL } from "../constants.js";

/** Drop keys whose value is "" or undefined; keep numbers/objects. */
function omitEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== "" && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** One input image for `generateImage`. A URL or a data: URI is sent as
 *  it is. A local path is held as its real spelling, the one the
 *  std::uploadImage interrupt shows, and read only after approval. */
export type ImageSource = { source: string; local: boolean };

/** Backs the checks `generateImage` makes before it asks anything. A
 *  local path is resolved to its real spelling and checked by name and
 *  stat: an image extension, a regular file, under the size cap. No byte
 *  is read, so a bad path fails here, before any approval is asked for. */
export function _imageSources(images: string[]): ImageSource[] {
  return images.map((image) => {
    if (isRemoteSource(image)) {
      return { source: image, local: false };
    }
    return { source: checkedImageFile(image, MAX_IMAGE_BYTES, "generateImage"), local: true };
  });
}

/** Where `generateImage` sends its request, as the default client will
 *  resolve it: the model it names or the default image model, and the
 *  provider it names or the one that model belongs to. A custom client may
 *  route the request elsewhere; this is the best that is known before the
 *  call. */
export function _imageDestination(
  model: string,
  provider: string,
): { model: string; provider: string } {
  const chosen = model || DEFAULT_IMAGE_MODEL;
  const owner = provider || smoltalk.getModel(chosen as smoltalk.ModelName)?.provider;
  return { model: chosen, provider: owner || "unknown" };
}

/** The request's input images. A local file is read here, after the
 *  approval, and sent as bytes, so the provider library never opens a
 *  path. `approvedFileBytes` refuses a symlink that appeared while the
 *  prompt was pending, and a file over the size cap. */
async function buildInput(host: Host, prompt: string, images: ImageSource[]): Promise<ImageInput> {
  if (images.length === 0) return prompt;
  const refs: ImageRef[] = [];
  for (const image of images) {
    if (!image.local) {
      refs.push(classifySource(image.source, "", false) as ImageRef);
      continue;
    }
    const mimeType = IMAGE_MIME_TYPES[path.extname(image.source).toLowerCase()];
    const data = await approvedFileBytes(host, image.source, MAX_IMAGE_BYTES);
    refs.push({ kind: "bytes", data, mimeType });
  }
  return { prompt, images: refs };
}

/** What one image request produced: the first image, or a failure
 *  message already worded for the caller to prefix. */
type OneImage = { image: ImageGenResult["images"][number] } | { error: string };

/** Runs one image request through the active client, with the accounting
 *  every image function shares: usage and tokens (only on success), the
 *  `imageGeneration` statelog event, and the guards. */
async function generateOne(
  run: Run,
  prompt: string,
  input: ImageInput,
  config: Partial<ImageConfig>,
  configuredModel: string,
): Promise<OneImage> {
  const { ctx, stack } = run;
  if (!ctx.llmClient.image) {
    return {
      error:
        "The active LLM client does not support image generation. Use the default client or register one with image() support.",
    };
  }
  const start = performance.now();
  // Metered dispatch: a rejected image() promise records one unresolved attempt
  // (so the throw still counts as an unpriced call), mirroring
  // the prompt path. A resolved failure Result is handled below (not metered
  // here — deferred to #809).
  const result = await meteredDispatch(ctx, stack, "image", () =>
    ctx.llmClient.image!(input, config),
  );
  const timeTaken = performance.now() - start;

  // Cost/statelog happen ONLY on success — a failed generation must not charge
  // the user or log the prompt.
  if (!result.success) {
    return { error: result.error };
  }
  const gen = result.value;
  const first = gen.images[0];

  // The provider dispatch resolved and cost real money whether or not it handed
  // back an image, so account its full usage in BOTH cases. Record usage and
  // tokens, trace the event (only when there is an image — the statelog contract
  // requires one), and enforce guards LAST — same ordering as the llm() path
  // (lib/runtime/prompt.ts). `recordUsage` bills the guards but does not throw;
  // the explicit `enforceGuards()` is the guard gate, so a trip still leaves the
  // spend accounted and (for a returned image) traced before it propagates, and
  // a trip wins over either return below.
  recordUsage(ctx, stack, {
    type: "provider",
    kind: "image",
    reportedModel: gen.model,
    configuredModel,
    cost: gen.costEstimate,
    tokens: gen.tokenUsage,
  });
  if (first) {
    run.log.imageGeneration({
      promptPreview: prompt.slice(0, PROMPT_PREVIEW_MAX),
      model: gen.model,
      timeTaken,
      usage: gen.tokenUsage,
      cost: gen.costEstimate === undefined ? undefined : { totalCost: gen.costEstimate.totalCost },
    });
  }
  stack.enforceGuards();
  if (!first) {
    return { error: "the provider returned no images." };
  }
  return { image: first };
}

/**
 * Backs `std::image.generateImage`. Calls the active client's image() method,
 * charges cost/guards + tokens (only on success), emits an `imageGeneration`
 * statelog event, and returns the first image as base64 + mimeType.
 */
export async function _generateImage(
  prompt: string,
  model: string,
  provider: string,
  size: string,
  quality: string,
  images: ImageSource[],
  apiKey: string,
  baseUrl: string,
): Promise<ResultValue> {
  const run = currentRun();
  // Declarative config. n:1 is explicit so a provider default of >1 can never
  // silently drop images.
  const config: Partial<ImageConfig> = omitEmpty({
    model,
    provider,
    size,
    quality: (quality || undefined) as ImageConfig["quality"] | undefined,
    n: 1,
    apiKey: apiKey
      ? { openAi: apiKey, google: apiKey, liteLlm: apiKey, openAiCompat: apiKey }
      : undefined,
    baseUrl: baseUrl ? { liteLlm: baseUrl, openAiCompat: baseUrl } : undefined,
  });
  let input: ImageInput;
  try {
    input = await buildInput(run.ctx.host, prompt, images);
  } catch (err) {
    return failure(`Image generation failed: ${(err as Error).message}`);
  }
  const out = await generateOne(run, prompt, input, config, model);
  if ("error" in out) {
    return failure(`Image generation failed: ${out.error}`);
  }
  return success({
    base64: encodeBase64(out.image.data),
    mimeType: out.image.mimeType,
  });
}

/** The request fields that carry a call's input images, with each file's
 *  bytes as base64: one string when the field takes one image, a list
 *  otherwise. The files are read here, after the Agency side raised
 *  std::readImage for each, so the server never opens a path a request
 *  wrote. `approvedFileBytes` refuses a symlink that appeared while the
 *  prompt was pending, and a file over the field's size cap. */
async function imageFields(host: Host, inputs: LocalImageInputs): Promise<Record<string, unknown>> {
  const encoded: Record<string, string[]> = {};
  for (const file of inputs.files) {
    const row = LOCAL_IMAGE_FIELDS[file.field];
    if (row === undefined) {
      throw new Error(`${file.field} is not an image field of the image server.`);
    }
    encoded[file.field] = [
      ...(encoded[file.field] ?? []),
      encodeBase64(await approvedFileBytes(host, file.path, row.maxBytes)),
    ];
  }
  return Object.fromEntries(
    Object.entries(encoded).map(([field, images]) => [field, fieldValue(field, images)]),
  );
}

/** Backs `std::image.generateImageLocal`: one image from the model that
 *  `agency local serve --image` is serving. */
export async function _generateImageLocal(
  prompt: string,
  model: string,
  size: string,
  steps: number | null,
  guidance: number | null,
  seed: number | null,
  negativePrompt: string,
  format: string,
  lora: string,
  loraScale: number | null,
  inputs: LocalImageInputs,
): Promise<ResultValue> {
  const run = currentRun();
  const fail = (message: string) => failure(`generateImageLocal failed: ${message}`);
  const checked = checkLocalImageArgs(prompt, model, format);
  if ("error" in checked) {
    return fail(checked.error);
  }
  let images: Record<string, unknown>;
  try {
    images = await imageFields(run.ctx.host, inputs);
  } catch (err) {
    return fail((err as Error).message);
  }
  const config: Partial<ImageConfig> = {
    model: checked.servedName,
    provider: "mlx",
    size,
    outputFormat: format as ImageConfig["outputFormat"],
    n: 1,
    metadata: {
      ...localImageSettings(steps, guidance, seed, negativePrompt, lora, loraScale),
      ...inputs.settings,
      ...images,
      references: referenceCount(inputs),
    },
  };
  const out = await generateOne(run, prompt, prompt, config, checked.servedName);
  if ("error" in out) {
    return fail(explainNoServer(out.error, mlxBaseUrl(), `agency local serve --image ${model}`));
  }
  const image = out.image as LocalGeneratedImage;
  return success({
    base64: encodeBase64(image.data),
    mimeType: image.mimeType,
    seed: image.seed ?? null,
  });
}
