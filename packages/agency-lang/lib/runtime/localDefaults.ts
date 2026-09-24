import type { SmolConfig } from "smoltalk";
import { localSamplingFor, type Sampling } from "../stdlib/modelCatalog.js";

/** The providers that run a model on this machine rather than over the
 *  network: the MLX server behind `agency local serve`, and llama.cpp
 *  inside this process. */
export const LOCAL_PROVIDERS = ["mlx", "llama-cpp"];

/** How a local model samples when a call names no temperature and its
 *  catalog entry names no sampling of its own. The local backends default
 *  to 0, which picks the single likeliest token every step: the same
 *  prompt then gives the same reply every time, and a model that starts
 *  going in circles cannot get out of them. Hosted providers sample at
 *  1.0, but on top of samplers of their own; on the MLX server, 1.0 with
 *  nothing else is sampling from the whole distribution, which a small
 *  4-bit model turns into noise. A catalog entry carries what its model
 *  card asks for (`localSamplingFor`); this is the fallback for a model
 *  the catalog does not know. */
export const DEFAULT_LOCAL_TEMPERATURE = 0.7;
export const DEFAULT_LOCAL_TOP_P = 0.95;

export type ThinkingOption = { enabled: boolean; budgetTokens?: number };
export type ReasoningEffort = "low" | "medium" | "high";

/** A program's limits on a reply that goes in circles, for the MLX chat
 *  server's watcher: how many second thoughts and how many repeats of one
 *  sentence it allows, and whether the answer is watched as well as the
 *  thinking. A field left out keeps the server's own setting. */
export type ReplyLimits = {
  hedgeLimit?: number;
  repeatLimit?: number;
  limitAnswers?: boolean;
};

/** Two sets of limits combined field by field, the second winning where
 *  both set a field. A branch default and a call's own limits combine
 *  this way, so a call that sets one field keeps the branch's others. */
export function mergedReplyLimits(
  base: ReplyLimits | undefined,
  over: ReplyLimits | undefined,
): ReplyLimits | undefined {
  if (base === undefined || over === undefined) {
    return over ?? base;
  }
  const merged: ReplyLimits = { ...base };
  for (const key of Object.keys(over) as (keyof ReplyLimits)[]) {
    if (over[key] !== undefined) {
      (merged as Record<string, unknown>)[key] = over[key];
    }
  }
  return merged;
}

/** The request fields the MLX chat server reads for the limits. */
export function mlxReplyLimitAttributes(
  limits: ReplyLimits,
  attributes: Record<string, unknown> = {},
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (limits.hedgeLimit !== undefined) {
    fields.hedge_limit = limits.hedgeLimit;
  }
  if (limits.repeatLimit !== undefined) {
    fields.repeat_limit = limits.repeatLimit;
  }
  if (limits.limitAnswers !== undefined) {
    fields.limit_answers = limits.limitAnswers;
  }
  return { ...attributes, ...fields };
}

/** Tokens of thinking for each `reasoningEffort` on a local model: the
 *  budgets the Google client uses for the same efforts, so "low" means the
 *  same amount of thinking whichever provider answers. */
export const EFFORT_BUDGETS: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

/** The local backend a call goes to, or undefined for a hosted one. A
 *  `.gguf` path with no provider named is llama.cpp: that is the provider
 *  smoltalk infers for it, and the call should get the local defaults
 *  whether or not the provider was spelled out. */
export function localProviderOf(config: Partial<SmolConfig>): "mlx" | "llama-cpp" | undefined {
  if (config.provider === "mlx" || config.provider === "llama-cpp") {
    return config.provider;
  }
  if (
    config.provider === undefined &&
    config.model !== undefined &&
    config.model.endsWith(".gguf")
  ) {
    return "llama-cpp";
  }
  return undefined;
}

/** The one thinking setting a call amounts to. A `thinking` option is
 *  taken as written. A `reasoningEffort` alone means thinking on, with the
 *  effort's budget. Undefined when the call said nothing. */
export function thinkingFor(
  thinking: ThinkingOption | undefined,
  effort: ReasoningEffort | undefined,
): ThinkingOption | undefined {
  if (thinking !== undefined) {
    if (thinking.enabled && thinking.budgetTokens === undefined && effort !== undefined) {
      return { enabled: true, budgetTokens: EFFORT_BUDGETS[effort] };
    }
    return thinking;
  }
  if (effort !== undefined) {
    return { enabled: true, budgetTokens: EFFORT_BUDGETS[effort] };
  }
  return undefined;
}

/** The request fields the MLX chat server reads for a call's thinking
 *  setting. `chat_template_kwargs` is mlx_lm's own, handed to the model's
 *  chat template: Qwen and Gemma templates read `enable_thinking`, and
 *  gpt-oss's reads `reasoning_effort` and has no switch. `reasoning_budget`
 *  is Agency's chat server's: the most tokens the model may think for
 *  before it is made to answer. */
export function mlxThinkingAttributes(
  thinking: ThinkingOption,
  effort: ReasoningEffort | undefined,
  attributes: Record<string, unknown> = {},
): Record<string, unknown> {
  const templateArgs = attributes.chat_template_kwargs;
  const withThinking = {
    ...attributes,
    chat_template_kwargs: {
      ...(typeof templateArgs === "object" && templateArgs !== null ? templateArgs : {}),
      enable_thinking: thinking.enabled,
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
    },
  };
  if (thinking.budgetTokens === undefined) {
    return withThinking;
  }
  return { ...withThinking, reasoning_budget: thinking.budgetTokens };
}

/** A call's config as the runtime assembles it: smoltalk's fields plus
 *  `replyLimits`, which is Agency's own and never reaches smoltalk. */
export type LocalCallConfig = Partial<SmolConfig> & { replyLimits?: ReplyLimits };

/** A call's config with the choices a hosted provider makes on its own
 *  made explicit for a local one. A call to a hosted provider is returned
 *  as it is: sending those providers a temperature they did not ask for
 *  is refused by some of their reasoning models.
 *
 *  The sampling comes from the model's catalog entry when it has one, else
 *  the local default. llama.cpp reads the temperature, `thinking`, and
 *  `reasoningEffort` from the config itself, with the same budgets, and
 *  the cut-offs from `rawAttributes` under node-llama-cpp's own names. The
 *  MLX server is reached through smoltalk's OpenAI-shaped client, which
 *  sends none of the sampling settings, so they go in `rawAttributes`,
 *  which that client copies into the request as they are, along with the
 *  thinking fields and the reply limits.
 *
 *  `defaultModel` is the model the run was started for. A draft model or a
 *  chat wrapper named for it in `metadata` is for that model only, so a
 *  call that names another model does not carry them. */
export function withLocalDefaults(
  config: LocalCallConfig,
  defaultModel?: string,
): Partial<SmolConfig> {
  const provider = localProviderOf(config);
  if (provider === undefined) {
    if (config.replyLimits === undefined) {
      return config;
    }
    const { replyLimits: _forTheMlxServer, ...hosted } = config;
    return hosted;
  }
  const { replyLimits, ...call } = config;
  const card = localSamplingFor(call.model ?? "");
  if (provider === "llama-cpp") {
    const metadata = llamaCppScopedTo(call, defaultModel);
    // A drafted model runs greedy unless the call says otherwise:
    // node-llama-cpp's draft predictor hung when a Qwen3.5 model sampled,
    // and the plugin refuses a sampled call on that family (and warns on
    // the others). Greedy is the one setting every pair takes.
    const drafted = metadata?.llamaCppDraftModel !== undefined;
    const fallback = drafted ? 0 : (card?.temperature ?? DEFAULT_LOCAL_TEMPERATURE);
    const temperature = call.temperature ?? fallback;
    const rawAttributes = llamaCppCutoffs(card, call.rawAttributes);
    return {
      ...call,
      temperature,
      metadata,
      ...(rawAttributes === undefined ? {} : { rawAttributes }),
    };
  }
  const temperature = call.temperature ?? card?.temperature ?? DEFAULT_LOCAL_TEMPERATURE;
  const sampling = { ...(call.rawAttributes ?? {}) };
  if (sampling.temperature === undefined) {
    sampling.temperature = temperature;
  }
  if (sampling.top_p === undefined) {
    sampling.top_p = card?.topP ?? DEFAULT_LOCAL_TOP_P;
  }
  if (sampling.top_k === undefined && card?.topK !== undefined) {
    sampling.top_k = card.topK;
  }
  const thinking = thinkingFor(call.thinking, call.reasoningEffort);
  const withThinking =
    thinking === undefined
      ? sampling
      : mlxThinkingAttributes(thinking, call.reasoningEffort, sampling);
  const rawAttributes =
    replyLimits === undefined ? withThinking : mlxReplyLimitAttributes(replyLimits, withThinking);
  return { ...call, temperature, rawAttributes };
}

/** The card's cut-offs for llama.cpp, under the names node-llama-cpp
 *  takes (`topP`, `topK`), added to the call's raw attributes where the
 *  call did not set them. Undefined when there is nothing to add. */
function llamaCppCutoffs(
  card: Sampling | undefined,
  rawAttributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (card === undefined || (card.topP === undefined && card.topK === undefined)) {
    return rawAttributes;
  }
  const cutoffs = { ...(rawAttributes ?? {}) };
  if (cutoffs.topP === undefined && card.topP !== undefined) {
    cutoffs.topP = card.topP;
  }
  if (cutoffs.topK === undefined && card.topK !== undefined) {
    cutoffs.topK = card.topK;
  }
  return cutoffs;
}

/** The fields in `metadata` that are for one model: the draft that drafts
 *  for it and the chat wrapper that formats its prompts. */
const PER_MODEL_METADATA = ["llamaCppDraftModel", "llamaCppChatWrapper"];

/** The call's metadata without the per-model fields meant for another
 *  model. */
function llamaCppScopedTo(
  config: Partial<SmolConfig>,
  defaultModel: string | undefined,
): Record<string, unknown> | undefined {
  const metadata = config.metadata as Record<string, unknown> | undefined;
  if (metadata === undefined || !PER_MODEL_METADATA.some((key) => metadata[key] !== undefined)) {
    return metadata;
  }
  if (defaultModel === undefined || config.model === undefined || config.model === defaultModel) {
    return metadata;
  }
  const scoped: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (!PER_MODEL_METADATA.includes(key)) {
      scoped[key] = metadata[key];
    }
  }
  return scoped;
}
