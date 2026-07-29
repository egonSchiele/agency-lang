import {
  isAssignable,
  isOptionalType,
  resolveType,
} from "../../typeChecker/assignability.js";
import { variableTypeToString } from "../../backends/typescriptGenerator/typeToString.js";
import { synthesizeType } from "./synthesizeType.js";
import type { ObjectType, TypeAliasEntry, VariableType } from "../../types.js";

/**
 * A sentence naming what is wrong with a rejected value, or null.
 *
 * CONTAINMENT RULE, and the reason this file is safe to exist: this walk
 * NEVER decides whether to reject. `isAssignable` has already decided.
 * This only annotates that decision, and returning null means "I cannot
 * localize it — use the general message". It is deliberately partial: it
 * handles the common record cases and declines everything else, rather
 * than growing into a second comparer that can disagree with the checker.
 *
 * Every sub-question it asks goes through `isAssignable` too. Comparing
 * printed type names instead would mis-blame any aliased property: given
 * `name: Name` and a missing `age`, it would report `name` as `string`
 * where `Name` is expected — confidently wrong, about a property that is
 * fine, while the real problem goes unnamed.
 */
export function explainMismatch(
  value: unknown,
  expected: VariableType,
  aliases: Record<string, TypeAliasEntry>,
  path: string = "",
): string | null {
  const target = resolveType(expected, aliases);
  if (target.type !== "objectType") return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  for (const property of (target as ObjectType).properties) {
    const label = path === "" ? property.key : `${path}.${property.key}`;
    // Property names come from a type declaration, but the record's keys
    // come from user data, so membership goes through Object.hasOwn.
    if (!Object.hasOwn(record, property.key)) {
      if (isOptionalType(property.value, aliases)) continue;
      return `is missing the required property \`${label}\``;
    }
    const propertyValue = record[property.key];
    // Literal-accurate, matching the second pass in `assertFillerType`.
    // With the widened description this would blame a property holding
    // "fast" against a `"fast" | "slow"` field — a property the final
    // decision considers fine.
    const actual = synthesizeType(propertyValue, { stringsAsLiterals: true });
    if (actual === null) continue;
    if (isAssignable(actual, property.value, aliases)) continue;
    // One level down before blaming this property: a nested record with a
    // missing field is far more useful reported as `address.city` than as
    // "address is wrong".
    const deeper = explainMismatch(propertyValue, property.value, aliases, label);
    if (deeper !== null) return deeper;
    const printedActual = variableTypeToString(actual, {}, true);
    const printedExpected = variableTypeToString(property.value, {}, true);
    return `has \`${label}\` as \`${printedActual}\` where \`${printedExpected}\` is expected`;
  }
  return null;
}
