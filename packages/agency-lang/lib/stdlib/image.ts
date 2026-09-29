import { performance } from "node:perf_hooks";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { success, failure, type ResultValue } from "../runtime/result.js";
import { recordUsage, meteredDispatch } from "../runtime/recordPaidUsage.js";
import { classifySource } from "./thread.js";
// One image type surface — imported from llmClient.ts, not smoltalk directly.
import type { ImageConfig, ImageGenResult, ImageInput, ImageRef } from "../runtime/llmClient.js";
import { _resolveModel, _mlxServedName, type ResolvedModel } from "./localModels.js";
import { mlxBaseUrl, isNoServerError } from "./mlxServerModels.js";
import { LOCAL_IMAGE_FORMATS, type LocalGeneratedImage } from "./mlxImage.js";
import { PROMPT_PREVIEW_MAX } from "../statelogClient.js";
import { approvedFileBytes } from "./approvedPath.js";
import { MAX_IMAGE_BYTES } from "./vision.js";

/** Drop keys whose value is "" or undefined; keep numbers/objects. */
function omitEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== "" && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Build a smoltalk ImageInput from a prompt + input image source strings. */
function buildInput(prompt: string, images: string[]): ImageInput {
  if (images.length === 0) return prompt;
  const refs: ImageRef[] = images.map((s) => classifySource(s, "", false) as ImageRef);
  return { prompt, images: refs };
}

/** What one image request produced: the first image, or a failure
 *  message already worded for the caller to prefix. */
type OneImage = { image: ImageGenResult["images"][number] } | { error: string };

/** Runs one image request through the active client, with the accounting
 *  every image function shares: usage and tokens (only on success), the
 *  `imageGeneration` statelog event, and the guards. */
async function generateOne(
  prompt: string,
  input: ImageInput,
  config: Partial<ImageConfig>,
  configuredModel: string,
): Promise<OneImage> {
  const { ctx, stack } = getRuntimeContext();
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
    ctx.statelogClient.imageGeneration({
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
  images: string[],
  apiKey: string,
  baseUrl: string,
): Promise<ResultValue> {
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
  const out = await generateOne(prompt, buildInput(prompt, images), config, model);
  if ("error" in out) {
    return failure(`Image generation failed: ${out.error}`);
  }
  return success({
    base64: Buffer.from(out.image.data).toString("base64"),
    mimeType: out.image.mimeType,
  });
}

/** The checks `generateImageLocal` makes before any request: a prompt, a
 *  format the server writes, and a model that is an image model. Returns
 *  the name to send the server, or a failure message. */
function checkLocalImageArgs(
  prompt: string,
  model: string,
  format: string,
): { servedName: string } | { error: string } {
  if (prompt.trim() === "") {
    return { error: "prompt cannot be empty." };
  }
  if (!LOCAL_IMAGE_FORMATS.includes(format)) {
    const others = LOCAL_IMAGE_FORMATS.slice(0, -1).join(", ");
    const last = LOCAL_IMAGE_FORMATS[LOCAL_IMAGE_FORMATS.length - 1];
    return { error: `format "${format}" is not supported. Use ${others}, or ${last}.` };
  }
  if (model === "") {
    return { error: "model cannot be empty." };
  }
  let resolved: ResolvedModel;
  try {
    resolved = _resolveModel(model);
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (resolved.backend !== "diffusers") {
    const what = resolved.backend === "mlx" ? "an MLX model" : "a GGUF model";
    return {
      error:
        `"${model}" is ${what}. Local image models are diffusers models served by ` +
        "agency local serve --image, such as z-image-turbo.",
    };
  }
  return { servedName: _mlxServedName(resolved) };
}

/** A ControlNet for one `generateImageLocal` call. `image` is the real
 *  spelling of the drawing the Agency side raised std::readImage for. */
export type LocalControl = {
  name: string;
  image: string;
  scale: number | null;
  invert: boolean;
};

/** The request fields for a ControlNet, with the drawing's bytes as
 *  base64. The file is read here, after the approval, so the server never
 *  opens a path a request wrote. `approvedFileBytes` refuses a symlink
 *  that appeared while the prompt was pending, and a file over the size
 *  the server takes. */
function controlFields(control: LocalControl | null): Record<string, unknown> {
  if (control === null) {
    return {};
  }
  const bytes = approvedFileBytes(control.image, MAX_IMAGE_BYTES);
  const fields: Record<string, unknown> = {
    controlnet: control.name,
    control_image: bytes.toString("base64"),
    control_invert: control.invert,
  };
  if (control.scale !== null) {
    fields.control_scale = control.scale;
  }
  return fields;
}

/** The settings a call gives, as the request fields the server takes. A
 *  null setting, or an empty negative prompt, is left out so the server
 *  uses the model card's value. */
function localImageSettings(
  steps: number | null,
  guidance: number | null,
  seed: number | null,
  negativePrompt: string,
  lora: string,
  loraScale: number | null,
): Record<string, unknown> {
  const given: [string, unknown][] = [
    ["steps", steps],
    ["guidance", guidance],
    ["seed", seed],
    ["negative_prompt", negativePrompt === "" ? null : negativePrompt],
    ["lora", lora === "" ? null : lora],
    ["lora_scale", loraScale],
  ];
  return Object.fromEntries(given.filter(([, value]) => value !== null));
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
  control: LocalControl | null,
): Promise<ResultValue> {
  const fail = (message: string) => failure(`generateImageLocal failed: ${message}`);
  const checked = checkLocalImageArgs(prompt, model, format);
  if ("error" in checked) {
    return fail(checked.error);
  }
  let controlled: Record<string, unknown>;
  try {
    controlled = controlFields(control);
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
      ...controlled,
    },
  };
  const out = await generateOne(prompt, prompt, config, checked.servedName);
  if ("error" in out) {
    if (isNoServerError(out.error)) {
      return fail(
        `no local model server answered at ${mlxBaseUrl()}. Start one with:\n  agency local serve --image ${model}`,
      );
    }
    return fail(out.error);
  }
  const image = out.image as LocalGeneratedImage;
  return success({
    base64: Buffer.from(image.data).toString("base64"),
    mimeType: image.mimeType,
    seed: image.seed ?? null,
  });
}
