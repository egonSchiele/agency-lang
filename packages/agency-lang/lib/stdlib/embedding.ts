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
 * Backs `std::embedding`'s `embed` and `embedMany`. Calls the active client's
 * embed() method, charges cost/guards + tokens (only on success), emits an
 * `embedCompletion` statelog event, and returns one vector per input.
 *
 * Follows `_generateImage` step for step: metered dispatch, then account
 * usage, trace, and enforce guards, in that order, so a guard trip wins over
 * any of the returns below.
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
    apiKey: apiKey
      ? {
          openAi: apiKey,
          google: apiKey,
          ollama: apiKey,
          deepInfra: apiKey,
          liteLlm: apiKey,
          openAiCompat: apiKey,
        }
      : undefined,
    baseUrl: baseUrl
      ? { ollama: baseUrl, deepInfra: baseUrl, liteLlm: baseUrl, openAiCompat: baseUrl }
      : undefined,
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

  // The provider charged us whether or not it handed back vectors, so account
  // usage either way. The trace event needs a vector length, so it fires only
  // when there is one. Guards go last so a trip wins over both returns below.
  recordUsage(ctx, stack, {
    type: "provider",
    kind: "embedding",
    reportedModel: res.model,
    configuredModel: model,
    cost: res.costEstimate,
    tokens: res.tokenUsage,
  });
  // The projected total, so a provider that reports input tokens without a
  // total (smoltalk-llama-cpp does) still counts toward getTokens().
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
