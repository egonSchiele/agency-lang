import type { VariableType } from "../types.js";
import { resolveKeysArg, resolveObjectArg } from "./builtinGenerics.js";
import { NEVER_T } from "./primitives.js";

/**
 * Eager evaluation for the type operators `keyof T` and `T["key"]`.
 * Both run during type resolution and produce ordinary types, so nothing
 * downstream knows the operator nodes exist.
 *
 * Argument validation is SHARED with the builtin generics
 * (resolveObjectArg / resolveKeysArg) so the error wording stays one
 * family across Partial, Pick, keyof, and indexed access.
 *
 * CYCLE RULE: this module must not import assignability.ts. The resolver
 * arrives as the `resolve` callback, carrying the caller's in-progress
 * guard, so recursive alias operands degrade the same way they do
 * everywhere else.
 */
type Resolve = (t: VariableType) => VariableType;

export function evalKeyof(
  operand: VariableType,
  resolve: Resolve,
): VariableType {
  const obj = resolveObjectArg("keyof", operand, resolve);
  const keys: VariableType[] = obj.properties.map((p) => ({
    type: "stringLiteralType",
    value: p.key,
  }));
  if (keys.length === 0) return NEVER_T;
  if (keys.length === 1) return keys[0];
  return { type: "unionType", types: keys };
}

export function evalIndexedAccess(
  objectType: VariableType,
  index: VariableType,
  resolve: Resolve,
): VariableType {
  const obj = resolveObjectArg("indexed access", objectType, resolve);
  const keys = resolveKeysArg("indexed access", index, resolve);
  const results = keys.map((key) => {
    const prop = obj.properties.find((p) => p.key === key);
    if (!prop) {
      const available = obj.properties.map((p) => p.key).join(", ");
      throw new TypeError(
        `indexed access key '${key}' does not exist on the target type. Available keys: ${available}`,
      );
    }
    return prop.value;
  });
  if (results.length === 1) return results[0];
  return { type: "unionType", types: results };
}
