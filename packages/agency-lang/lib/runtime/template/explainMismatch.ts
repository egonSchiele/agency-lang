import {
  isAssignable,
  isOptionalType,
  safeResolveType,
} from "../../typeChecker/assignability.js";
import { variableTypeToString } from "../../backends/typescriptGenerator/typeToString.js";
import { synthesizeType } from "./synthesizeType.js";
import type { ObjectType, TypeAliasEntry, VariableType } from "../../types.js";

/**
 * A sentence naming what is wrong with a rejected value, or null.
 *
 * CONTAINMENT RULE: this walk NEVER decides whether to reject —
 * `isAssignable` already has. It only annotates, and null means "cannot
 * localize, use the general message". Deliberately partial, so it never
 * grows into a second comparer that can disagree with the checker.
 *
 * Every sub-question goes through `isAssignable` too. Comparing printed
 * names would mis-blame an aliased property: `name: Name` given "Alice"
 * reads as wrong while the real problem, a missing `age`, goes unnamed.
 */
export function explainMismatch(
  value: unknown,
  expected: VariableType,
  aliases: Record<string, TypeAliasEntry>,
  path: string = "",
): string | null {
  const target = safeResolveType(expected, aliases);
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
    // Literal-accurate, matching assertFillerType's second pass: widened,
    // this would blame a `"fast"` property the decision considers fine.
    const actual = synthesizeType(propertyValue, { stringsAsLiterals: true });
    if (actual === null) continue;
    if (isAssignable(actual, property.value, aliases)) continue;
    // One level down first: `address.city` beats "address is wrong".
    const deeper = explainMismatch(propertyValue, property.value, aliases, label);
    if (deeper !== null) return deeper;
    const printedActual = variableTypeToString(actual, {}, true);
    const printedExpected = variableTypeToString(property.value, {}, true);
    return `has \`${label}\` as \`${printedActual}\` where \`${printedExpected}\` is expected`;
  }
  return null;
}
