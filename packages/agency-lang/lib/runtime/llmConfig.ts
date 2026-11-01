import {
  getModel,
  resolveModelForProvider,
  type DecideConfig,
  type ModelType,
  type SmolConfig,
} from "smoltalk";

import { DEFAULT_MODEL, defaultRoute, type AgencyConfig } from "../config/config.js";

export type LlmBaseUrls = NonNullable<SmolConfig["baseUrl"]> &
  Pick<NonNullable<DecideConfig["baseUrl"]>, "typesafe">;

/** Prefer the selected provider's record when several providers share a name. */
export function modelRecord(config: Partial<SmolConfig>): ModelType | undefined {
  if (config.model === undefined) {
    return undefined;
  }
  if (config.provider !== undefined) {
    const record = resolveModelForProvider(config.provider, config.model, config.modelData);
    if (record !== undefined) {
      return record;
    }
  }
  return getModel(config.model, config.modelData);
}

/** Switching between text and decision models selects the new model's provider.
 * An explicit provider or a repeated model keeps the selected route. */
export function modelProviderOverride(
  defaults: Partial<SmolConfig>,
  override: Partial<SmolConfig>,
): string | undefined {
  if (
    override.model === undefined ||
    override.model === defaults.model ||
    override.provider !== undefined
  ) {
    return undefined;
  }
  const record = modelRecord({ ...defaults, ...override, provider: undefined });
  if (record?.type === "decision") {
    return record.provider;
  }
  const previous = modelRecord(defaults);
  const wasDecision =
    previous?.type === "decision" || (previous === undefined && defaults.provider === "typesafe");
  if (wasDecision && record?.type === "text") {
    return record.provider;
  }
  return undefined;
}

export function mergeLlmConfig(
  defaults: Partial<SmolConfig>,
  override: Partial<SmolConfig>,
): Partial<SmolConfig> {
  const merged = { ...defaults, ...override };
  if (override.baseUrl !== undefined) {
    merged.baseUrl = { ...defaults.baseUrl, ...override.baseUrl };
  }
  const provider = modelProviderOverride(defaults, override);
  if (provider !== undefined) {
    merged.provider = provider;
  }
  return merged;
}

/** The smoltalk defaults a `client` config block gives over the baked ones:
 *  the keys and base URLs merged per provider, the log level and the
 *  OpenRouter preferences replaced whole, and the model with its provider
 *  by `defaultRoute`, the compile-time rule, with the baked model and
 *  provider as the fallback. */
export function inheritClientDefaults(
  baked: Partial<SmolConfig>,
  client: NonNullable<AgencyConfig["client"]>,
): Partial<SmolConfig> {
  const override: Partial<SmolConfig> = {};
  if (client.apiKey !== undefined) {
    override.apiKey = { ...baked.apiKey, ...client.apiKey };
  }
  if (client.baseUrl !== undefined) {
    override.baseUrl = client.baseUrl;
  }
  if (client.logLevel !== undefined) {
    override.logLevel = client.logLevel;
  }
  if (client.openRouter !== undefined) {
    override.openRouter = client.openRouter;
  }
  const merged = mergeLlmConfig(baked, override);
  if (client.defaultModel === undefined && client.defaultProvider === undefined) {
    return merged;
  }
  const route = defaultRoute(client, {
    model: baked.model ?? DEFAULT_MODEL,
    provider: baked.provider,
  });
  merged.model = route.model;
  if (route.provider === undefined) {
    delete merged.provider;
  } else {
    merged.provider = route.provider;
  }
  return merged;
}
