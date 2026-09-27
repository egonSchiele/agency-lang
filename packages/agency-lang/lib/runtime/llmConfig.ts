import {
  getModel,
  resolveModelForProvider,
  type DecideConfig,
  type ModelType,
  type SmolConfig,
} from "smoltalk";

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
