import { performance } from "node:perf_hooks";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { success, failure, type ResultValue } from "../runtime/result.js";
import { addCost, addTokens } from "../runtime/cost.js";
import { classifySource } from "./thread.js";
// One image type surface — imported from llmClient.ts, not smoltalk directly.
import type { ImageConfig, ImageInput, ImageRef } from "../runtime/llmClient.js";
import { PROMPT_PREVIEW_MAX } from "../statelogClient.js";

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
  const refs: ImageRef[] = images.map(
    (s) => classifySource(s, "", false) as ImageRef,
  );
  return { prompt, images: refs };
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
  const { ctx } = getRuntimeContext();
  if (!ctx.llmClient.image) {
    return failure(
      "The active LLM client does not support image generation. Use the default client or register one with image() support.",
    );
  }

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

  const start = performance.now();
  const result = await ctx.llmClient.image(buildInput(prompt, images), config);
  const timeTaken = performance.now() - start;

  // Cost/statelog happen ONLY on success — a failed generation must not charge
  // the user or log the prompt.
  if (!result.success) {
    return failure(`Image generation failed: ${result.error}`);
  }
  const gen = result.value;
  const first = gen.images[0];
  if (!first) {
    return failure("Image generation returned no images.");
  }

  // Reuse the declarative cost interface: addCost bills guards + enforces (may
  // throw a guard trip, which must propagate); addTokens accrues the counter.
  addCost(gen.costEstimate?.totalCost ?? 0);
  addTokens(gen.tokenUsage?.totalTokens ?? 0);

  ctx.statelogClient.imageGeneration({
    promptPreview: prompt.slice(0, PROMPT_PREVIEW_MAX),
    model: gen.model,
    timeTaken,
    usage: gen.tokenUsage,
    cost:
      gen.costEstimate === undefined
        ? undefined
        : { totalCost: gen.costEstimate.totalCost },
  });

  return success({
    base64: Buffer.from(first.data).toString("base64"),
    mimeType: first.mimeType,
  });
}
