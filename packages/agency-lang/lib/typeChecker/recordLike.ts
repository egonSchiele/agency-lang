import type { VariableType } from "../types.js";
import { STRING_T, ANY_T } from "./primitives.js";
import { unionTypes } from "./inference.js";

/**
 * The key and value types of a "record-like" type — a `Record<K, V>` generic or
 * a structural object literal (`objectType`) — or `undefined` for anything else.
 *
 * Object literals iterate and index by string key; their value type is the
 * union of all property value types (or `any` for the empty object, which
 * carries no value-type info). Centralizing this keeps the for-loop typer
 * (`scopes.ts`) and index-access synthesis (`synthesizer.ts`) from each
 * inventing their own rule for what an object literal's value type is — so
 * `for (k, v in obj)` and `obj[k]` agree by construction.
 *
 * Expects an already-resolved type (aliases expanded).
 */
export function recordLikeKeyValue(
  t: VariableType,
): { key: VariableType; value: VariableType } | undefined {
  if (t.type === "genericType" && t.name === "Record") {
    return { key: t.typeArgs[0], value: t.typeArgs[1] };
  }
  if (t.type === "objectType") {
    const value =
      t.properties.length === 0
        ? ANY_T
        : unionTypes(t.properties.map((p) => p.value));
    return { key: STRING_T, value };
  }
  return undefined;
}
