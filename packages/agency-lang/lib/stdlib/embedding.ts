import { performance } from "node:perf_hooks";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { success, failure, type ResultValue } from "../runtime/result.js";
import { addTokens } from "../runtime/cost.js";
import { recordUsage, meteredDispatch } from "../runtime/recordPaidUsage.js";
import { projectProviderTokenUsage } from "../runtime/invocationUsage.js";
// One embedding type surface — imported from llmClient.ts, not smoltalk directly.
import type { EmbedConfig } from "../runtime/llmClient.js";
import { PROMPT_PREVIEW_MAX } from "../statelogClient.js";

/** Drop keys whose value is "", 0, or undefined; keep everything else. */
function omitEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== "" && v !== 0 && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * smoltalk reads the API key from a per-provider slot, and it resolves the
 * provider from the model name only after this call hands the config over.
 * So the one key the caller gave is copied into every slot smoltalk knows,
 * and smoltalk picks the slot for the provider it resolves.
 */
function keyForEveryProvider(apiKey: string): EmbedConfig["apiKey"] {
  return {
    openAi: apiKey,
    google: apiKey,
    ollama: apiKey,
    deepInfra: apiKey,
    liteLlm: apiKey,
    openAiCompat: apiKey,
  };
}

/** Same reasoning as keyForEveryProvider, for the base URL. */
function baseUrlForEveryProvider(baseUrl: string): EmbedConfig["baseUrl"] {
  return {
    ollama: baseUrl,
    mlx: baseUrl,
    deepInfra: baseUrl,
    liteLlm: baseUrl,
    openAiCompat: baseUrl,
  };
}

/**
 * Backs `std::embedding`'s `embed` and `embedMany`. Calls the active client's
 * embed() method, records cost and tokens, emits an `embedCompletion`
 * statelog event, enforces guards, and returns one vector per input.
 */
export async function _embedTexts(
  texts: string[],
  model: string,
  provider: string,
  dimensions: number,
  apiKey: string,
  baseUrl: string,
): Promise<ResultValue> {
  const { ctx, stack } = getRuntimeContext();
  if (texts.length === 0) {
    return failure("Nothing to embed: the input list is empty.");
  }
  const blank = texts.findIndex((t) => t.trim() === "");
  if (blank !== -1) {
    return failure(`Nothing to embed: input ${blank} is empty.`);
  }

  const config: Partial<EmbedConfig> = omitEmpty({
    model,
    provider,
    dimensions,
    apiKey: apiKey ? keyForEveryProvider(apiKey) : undefined,
    baseUrl: baseUrl ? baseUrlForEveryProvider(baseUrl) : undefined,
  });

  const start = performance.now();
  const result = await meteredDispatch(ctx, stack, "embedding", () =>
    ctx.llmClient.embed(texts, config),
  );
  const timeTaken = performance.now() - start;

  if (!result.success) {
    return failure(`Embedding failed: ${result.error}`);
  }
  const res = result.value;
  const first = res.embeddings[0];

  // Usage is recorded whether or not vectors came back, because the provider
  // charged for the call either way. Guards run last so a trip wins over the
  // count-mismatch failure below.
  recordUsage(ctx, stack, {
    type: "provider",
    kind: "embedding",
    reportedModel: res.model,
    configuredModel: model,
    cost: res.costEstimate,
    tokens: res.tokenUsage,
  });
  // Some providers report input tokens with no total. The projection sums
  // the parts so those calls still count toward getTokens().
  addTokens(projectProviderTokenUsage(res.tokenUsage, "embedding").usage.totalTokens);
  if (first) {
    ctx.statelogClient.embedCompletion({
      inputPreview: texts[0].slice(0, PROMPT_PREVIEW_MAX),
      inputCount: texts.length,
      model: res.model,
      dimensions: first.length,
      timeTaken,
      usage: res.tokenUsage,
      cost: res.costEstimate === undefined ? undefined : { totalCost: res.costEstimate.totalCost },
      phase: "std::embedding",
    });
  }
  stack.enforceGuards();

  if (res.embeddings.length !== texts.length) {
    return failure(
      `Embedding returned ${res.embeddings.length} vectors for ${texts.length} inputs.`,
    );
  }
  return success({ vectors: res.embeddings, model: res.model });
}

/** Backs `std::embedding.cosineSimilarity`. Pure arithmetic, no runtime context. */
export function _cosineSimilarity(a: number[], b: number[]): ResultValue {
  if (a.length !== b.length) {
    return failure(`Vectors have different lengths: ${a.length} and ${b.length}.`);
  }
  if (a.length === 0) {
    return failure("Vectors are empty.");
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return failure("Cosine similarity is undefined for an all-zero vector.");
  }
  return success(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}
