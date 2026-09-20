import { ANY_T } from "./primitives.js";
import { isAnyType } from "./utils.js";
import type { TypeAliasEntry } from "../types.js";
import type { ScopeType } from "./scope.js";
import { safeResolveType } from "./assignability.js";
import type { PathSegment } from "./pathSegments.js";

/**
 * Resolve successive path hops on a type — DIAGNOSTIC-FREE (unlike
 * `synthValueAccess`, which emits strict-member-access errors). Returns "any" on
 * any hop that can't be resolved (missing property, non-object/Record/array
 * receiver), so path narrowing stays conservative. Handles property and
 * literal-index hops (no tuple types exist, so an index resolves to the array
 * element type regardless of the index value).
 */
export function resolvePath(
  baseType: ScopeType,
  chain: PathSegment[],
  aliases: Record<string, TypeAliasEntry>,
): ScopeType {
  let current: ScopeType = baseType;
  for (const seg of chain) {
    if (isAnyType(current)) return ANY_T;
    const resolved = safeResolveType(current, aliases);
    if (seg.kind === "prop") {
      if (resolved.type === "objectType") {
        const p = resolved.properties.find((pr) => pr.key === seg.name);
        current = p ? p.value : ANY_T;
      } else if (resolved.type === "genericType" && resolved.name === "Record") {
        current = resolved.typeArgs[1];
      } else {
        return ANY_T;
      }
    } else {
      // index segment: array element, or Record value (Record<K,V>[i] → V)
      if (resolved.type === "arrayType") {
        current = resolved.elementType;
      } else if (resolved.type === "genericType" && resolved.name === "Record") {
        current = resolved.typeArgs[1];
      } else {
        return ANY_T;
      }
    }
  }
  return current;
}
