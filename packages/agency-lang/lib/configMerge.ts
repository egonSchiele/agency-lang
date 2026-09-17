import { isPlainObject, matchesConfigPath } from "./configPaths.js";

/** A config path whose value the local file replaces whole. Each rule must
 *  also be listed in docs/site/guide/agency-config-file.md. */
export type ConfigMergeRule = { path: string; why: string };

export const CONFIG_MERGE_RULES: ConfigMergeRule[] = [
  {
    path: "mcpServers.*",
    why: "A server's fields depend on each other. Mixing two servers can change its transport.",
  },
  {
    path: "client.modelAliases.*",
    why: "An alias's hash, companions, and source belong to its own model.",
  },
];

/** Assigning this key changes an object's prototype. */
const UNSAFE_KEY = "__proto__";

function replacedWhole(keys: string[]): boolean {
  return CONFIG_MERGE_RULES.some((rule) => matchesConfigPath(rule.path, keys));
}

function safeKeys(value: Record<string, any>): string[] {
  return Object.keys(value).filter((key) => key !== UNSAFE_KEY);
}

function safeCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(safeCopy);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(safeKeys(value).map((key) => [key, safeCopy(value[key])]));
}

function mergeValue(base: unknown, override: unknown, keys: string[]): unknown {
  if (!isPlainObject(base) || !isPlainObject(override) || replacedWhole(keys)) {
    return safeCopy(override);
  }
  return mergeAt(base, override, keys);
}

function mergeAt(
  base: Record<string, any>,
  override: Record<string, any>,
  keys: string[],
): Record<string, any> {
  const baseOnly = safeKeys(base).filter((key) => !Object.hasOwn(override, key));
  const fromBase = baseOnly.map((key) => [key, safeCopy(base[key])]);
  const fromOverride = safeKeys(override).map((key) => [
    key,
    mergeValue(base[key], override[key], [...keys, key]),
  ]);
  return Object.fromEntries([...fromBase, ...fromOverride]);
}

/**
 * Merge `override` into `base` and return a new object. Objects merge key by
 * key. Arrays, other values, and values at a CONFIG_MERGE_RULES path replace
 * the base value.
 */
export function mergeConfig(
  base: Record<string, any>,
  override: Record<string, any>,
): Record<string, any> {
  return mergeAt(base, override, []);
}
