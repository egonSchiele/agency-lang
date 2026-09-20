import { ANY_T } from "./primitives.js";
import { isAnyType } from "./utils.js";
import type { TypeAliasEntry } from "../types.js";
import type { ScopeType } from "./scope.js";
import { safeResolveType } from "./assignability.js";
import type { PathSegment } from "./pathSegments.js";

/** The declared type at the end of a member path, walked structurally from
 *  the base's type. `any` when a hop cannot be resolved. */
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

/** The DECLARED (un-narrowed) type of a path, from the base var's scope type. */
