import type { TypeAliasEntry, VariableType } from "../types/typeHints.js";
import { safeResolveType } from "./assignability.js";
import { isNullType } from "./builtinGenerics.js";
import { isAnyType } from "./utils.js";

/**
 * A failure's data has to be an object. A failure's message is always a string
 * and is never named in the type, so `Result<T, string>` is refused. No
 * `failure()` call can produce string data.
 *
 * `any` passes. A union passes when every arm does. `null` passes, so
 * `failure("x", null)` and a `D | null` data type are both writable.
 */
export function isDataShaped(t: VariableType, aliases: Record<string, TypeAliasEntry>): boolean {
  const resolved = safeResolveType(t, aliases);
  if (isAnyType(resolved) || isNullType(resolved)) {
    return true;
  }
  if (resolved.type === "unionType") {
    return resolved.types.every((member) => isDataShaped(member, aliases));
  }
  return resolved.type === "objectType";
}
