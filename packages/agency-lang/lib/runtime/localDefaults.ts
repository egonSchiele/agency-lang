import type { SmolConfig } from "smoltalk";

/** The providers that run a model on this machine rather than over the
 *  network: the MLX server behind `agency local serve`, and llama.cpp
 *  inside this process. */
export const LOCAL_PROVIDERS = ["mlx", "llama-cpp"];

/** How a local model samples when a call names no temperature. The local
 *  backends default to 0, which picks the single likeliest token every
 *  step: the same prompt then gives the same reply every time, and a model
 *  that starts going in circles cannot get out of them. Hosted providers
 *  sample at 1.0, but on top of samplers of their own; on the MLX server,
 *  1.0 with nothing else is sampling from the whole distribution, which a
 *  small 4-bit model turns into noise. These are the settings the Qwen and
 *  Gemma model cards ask for, and close to what node-llama-cpp applies on
 *  its own at any temperature above zero. */
export const DEFAULT_LOCAL_TEMPERATURE = 0.7;
export const DEFAULT_LOCAL_TOP_P = 0.95;

export type ThinkingOption = { enabled: boolean; budgetTokens?: number };
export type ReasoningEffort = "low" | "medium" | "high";

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

/** A call's config with the choices a hosted provider makes on its own
 *  made explicit for a local one. A call to a hosted provider is returned
 *  as it is: sending those providers a temperature they did not ask for
 *  is refused by some of their reasoning models.
 *
 *  llama.cpp reads the temperature, `thinking`, and `reasoningEffort` from
 *  the config itself, with the same budgets. The MLX server is reached
 *  through smoltalk's OpenAI-shaped client, which sends none of the
 *  sampling settings, so they go in `rawAttributes`, which that client
 *  copies into the request as they are.
 *
 *  `defaultModel` is the model the run was started for. A draft model
 *  named for it (`llamaCppDraftModel` in `metadata`) drafts for that model
 *  only, so a call that names another model does not carry it. */
export function withLocalDefaults(
  config: Partial<SmolConfig>,
  defaultModel?: string,
): Partial<SmolConfig> {
  const provider = localProviderOf(config);
  if (provider === undefined) {
    return config;
  }
  if (provider === "llama-cpp") {
    const metadata = draftScopedTo(config, defaultModel);
    // A drafted model runs greedy unless the call says otherwise:
    // node-llama-cpp's draft predictor only works at temperature 0, and
    // the plugin refuses a call that samples on a drafted model.
    const drafted = metadata?.llamaCppDraftModel !== undefined;
    const temperature = config.temperature ?? (drafted ? 0 : DEFAULT_LOCAL_TEMPERATURE);
    return { ...config, temperature, metadata };
  }
  const temperature = config.temperature ?? DEFAULT_LOCAL_TEMPERATURE;
  const sampling = { ...(config.rawAttributes ?? {}) };
  if (sampling.temperature === undefined) {
    sampling.temperature = temperature;
  }
  if (sampling.top_p === undefined) {
    sampling.top_p = DEFAULT_LOCAL_TOP_P;
  }
  const thinking = thinkingFor(config.thinking, config.reasoningEffort);
  const rawAttributes =
    thinking === undefined
      ? sampling
      : mlxThinkingAttributes(thinking, config.reasoningEffort, sampling);
  return { ...config, temperature, rawAttributes };
}

/** The call's metadata without a draft model meant for another model. */
function draftScopedTo(
  config: Partial<SmolConfig>,
  defaultModel: string | undefined,
): Record<string, unknown> | undefined {
  const metadata = config.metadata as Record<string, unknown> | undefined;
  if (metadata === undefined || metadata.llamaCppDraftModel === undefined) {
    return metadata;
  }
  if (defaultModel === undefined || config.model === undefined || config.model === defaultModel) {
    return metadata;
  }
  const { llamaCppDraftModel: _forAnotherModel, ...rest } = metadata;
  return rest;
}
