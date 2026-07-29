import type { AgencyNode, TypeAlias, TypeAliasEntry } from "../../types.js";

/**
 * A template's own type aliases, in the shape the type checker's resolver
 * expects.
 *
 * A template carries its type declarations with it — `type Person = { … }`
 * is part of the same `Code` value being filled — which is what makes
 * resolving a hole's declared type possible at run time without a compile.
 *
 * Top level only. Aliases declared inside a body are not in scope at a
 * top-level hole, and an alias this table cannot find is treated as
 * unknowable by the caller rather than as an error.
 *
 * `typeParams`, `valueParams` and `tags` are carried, not just `body`:
 * generic and value-parameterized aliases are legal in templates, and
 * dropping those fields would make such an alias resolve WRONGLY rather
 * than not at all — the worse failure. `typeParams` is load-bearing in a
 * second way: `hasUnresolvedName` reads it to tell an alias's own bound
 * parameter (`T` in `type Box<T> = { item: T }`) from a name that genuinely
 * cannot be resolved. Without it every generic alias would look unresolvable
 * and be skipped.
 */
export function aliasTableFrom(
  nodes: AgencyNode[],
): Record<string, TypeAliasEntry> {
  // Alias names come from user source, so null-prototype (house pattern).
  const table: Record<string, TypeAliasEntry> = Object.create(null);
  for (const node of nodes) {
    if (node.type !== "typeAlias") continue;
    const alias = node as TypeAlias;
    const entry: TypeAliasEntry = { body: alias.aliasedType };
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
