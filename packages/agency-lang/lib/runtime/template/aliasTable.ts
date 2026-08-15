import type { AgencyNode, TypeAlias, TypeAliasEntry } from "../../types.js";

/**
 * A template's own type aliases, in the shape the checker's resolver wants.
 *
 * Top level only: an alias declared inside a body is not in scope at a
 * top-level hole. `hasUnresolvedName` treats a name missing from this table
 * as unknowable, so a gap here means fills go unchecked, never wrongly
 * rejected.
 */
export function aliasTableFrom(nodes: AgencyNode[]): Record<string, TypeAliasEntry> {
  // Null-prototype: alias names are user-controlled keys (house pattern).
  const table: Record<string, TypeAliasEntry> = Object.create(null);
  for (const node of nodes) {
    if (node.type !== "typeAlias") continue;
    const alias = node as TypeAlias;
    const entry: TypeAliasEntry = { body: alias.aliasedType };
    // typeParams is load-bearing twice: the resolver substitutes with it,
    // and hasUnresolvedName reads it to tell `T` in `type Box<T>` from a
    // name that genuinely does not resolve.
    if (alias.typeParams !== undefined) {
      entry.typeParams = alias.typeParams;
    }
    if (alias.valueParams !== undefined) {
      entry.valueParams = alias.valueParams;
    }
    if (alias.tags !== undefined) {
      entry.tags = alias.tags;
    }
    if (alias.isEffectSet !== undefined) {
      entry.isEffectSet = alias.isEffectSet;
    }
    table[alias.aliasName] = entry;
  }
  return table;
}
