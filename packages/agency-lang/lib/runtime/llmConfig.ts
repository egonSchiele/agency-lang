import {
  getModel,
  resolveModelForProvider,
  type DecideConfig,
  type ModelType,
  type SmolConfig,
} from "smoltalk";

/** URL settings shared by text and decision calls. */
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

/** A model-only switch to a decision model selects its registry provider.
 * Repeating the current model keeps its chosen provider. */
export function decisionProviderOverride(
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
  return record?.type === "decision" ? record.provider : undefined;
}

export function mergeLlmConfig(
  defaults: Partial<SmolConfig>,
  override: Partial<SmolConfig>,
): Partial<SmolConfig> {
  const merged = { ...defaults, ...override };
  if (override.baseUrl !== undefined) {
    merged.baseUrl = { ...defaults.baseUrl, ...override.baseUrl };
  }
  const provider = decisionProviderOverride(defaults, override);
  if (provider !== undefined) {
    merged.provider = provider;
  }
  return merged;
}
