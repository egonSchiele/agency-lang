import { performance } from "node:perf_hooks";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { success, failure, type ResultValue } from "../runtime/result.js";
import { addTokens } from "../runtime/cost.js";
import { recordUsage, meteredDispatch } from "../runtime/recordPaidUsage.js";
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
  const refs: ImageRef[] = images.map((s) => classifySource(s, "", false) as ImageRef);
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
  const { ctx, stack } = getRuntimeContext();
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
  // Metered dispatch: a rejected image() promise records one unresolved attempt
  // (so pricingComplete cannot stay true after a post-dispatch throw), mirroring
  // the prompt path. A resolved failure Result is handled below (not metered
  // here — deferred to #809).
  const result = await meteredDispatch(ctx, stack, "image", () =>
    ctx.llmClient.image!(buildInput(prompt, images), config),
  );
  const timeTaken = performance.now() - start;

  // Cost/statelog happen ONLY on success — a failed generation must not charge
  // the user or log the prompt.
  if (!result.success) {
    return failure(`Image generation failed: ${result.error}`);
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
    configuredModel: model,
    cost: gen.costEstimate,
    tokens: gen.tokenUsage,
  });
  addTokens(gen.tokenUsage?.totalTokens ?? 0);
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
    return failure("Image generation returned no images.");
  }
  return success({
    base64: Buffer.from(first.data).toString("base64"),
    mimeType: first.mimeType,
  });
}
