import type { SmolConfig } from "smoltalk";

/** The providers that run a model on this machine rather than over the
 *  network: the MLX server behind `agency local serve`, and llama.cpp
 *  inside this process. */
export const LOCAL_PROVIDERS = ["mlx", "llama-cpp"];

/** What every hosted provider samples at when a call names no temperature.
 *  The local backends default to 0 instead, which picks the single
 *  likeliest token every step: the same prompt then gives the same reply
 *  every time, and a model that starts going in circles cannot get out of
 *  them. A local model gets the hosted default, so the two behave alike. */
export const DEFAULT_LOCAL_TEMPERATURE = 1.0;

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
 *  setting. `chat_template_kwargs` is mlx_lm's own: the model's chat
 *  template reads `enable_thinking` and opens no thinking block when it is
 *  false. `reasoning_budget` is Agency's chat server's: the most tokens the
 *  model may think for before it is made to answer. */
export function mlxThinkingAttributes(
  thinking: ThinkingOption,
  attributes: Record<string, unknown> = {},
): Record<string, unknown> {
  const templateArgs = attributes.chat_template_kwargs;
  const withThinking = {
    ...attributes,
    chat_template_kwargs: {
      ...(typeof templateArgs === "object" && templateArgs !== null ? templateArgs : {}),
      enable_thinking: thinking.enabled,
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
 *  llama.cpp reads `thinking` and `reasoningEffort` itself, with the same
 *  budgets, so only the MLX server needs them translated here. */
export function withLocalDefaults(config: Partial<SmolConfig>): Partial<SmolConfig> {
  if (!LOCAL_PROVIDERS.includes(config.provider ?? "")) {
    return config;
  }
  const withTemperature =
    config.temperature === undefined
      ? { ...config, temperature: DEFAULT_LOCAL_TEMPERATURE }
      : config;
  if (config.provider !== "mlx") {
    return withTemperature;
  }
  const thinking = thinkingFor(config.thinking, config.reasoningEffort);
  if (thinking === undefined) {
    return withTemperature;
  }
  return {
    ...withTemperature,
    rawAttributes: mlxThinkingAttributes(thinking, config.rawAttributes),
  };
}
