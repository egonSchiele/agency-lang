import {
  getAllModels,
  getModel,
  isDecisionModel,
  resolveModelForProvider,
  type DecideConfig,
  type DecisionModel,
  type ModelDataBlob,
  type ModelType,
  type SmolConfig,
} from "smoltalk";

import { DEFAULT_MODEL, defaultRoute, type AgencyConfig } from "../config/config.js";

export type LlmBaseUrls = NonNullable<SmolConfig["baseUrl"]> &
  Pick<NonNullable<DecideConfig["baseUrl"]>, "typesafe" | "laya">;

/** One layer of an `llm()` call's options as the merge sees them:
 *  smoltalk's config plus the per-call `decision` flag, which picks a
 *  decision call (`isDecisionCall`) and is never sent to smoltalk. */
export type CallConfig = Partial<SmolConfig> & { decision?: boolean };

/** The first decision entry for a model name, in catalog order. A name can
 *  have several (`jev-1.14` under `typesafe` and `openrouter`) and a text
 *  entry too (`gpt-6-luna`). */
function firstDecisionEntry(model: string, modelData?: ModelDataBlob): DecisionModel | undefined {
  return getAllModels(modelData)
    .filter(isDecisionModel)
    .find((entry) => entry.modelName === model);
}

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
 * An explicit provider or a repeated model keeps the selected route. A call
 * with `decision: true` switches to the provider of the model's first
 * decision entry, and keeps the route when the model has none. */
export function modelProviderOverride(
  defaults: Partial<SmolConfig>,
  override: Partial<SmolConfig>,
  decision: boolean = false,
): string | undefined {
  if (
    override.model === undefined ||
    override.model === defaults.model ||
    override.provider !== undefined
  ) {
    return undefined;
  }
  if (decision) {
    return firstDecisionEntry(override.model, override.modelData ?? defaults.modelData)?.provider;
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

export function mergeLlmConfig(defaults: CallConfig, override: CallConfig): CallConfig {
  const merged = { ...defaults, ...override };
  if (override.baseUrl !== undefined) {
    merged.baseUrl = { ...defaults.baseUrl, ...override.baseUrl };
  }
  const provider = modelProviderOverride(defaults, override, override.decision === true);
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
