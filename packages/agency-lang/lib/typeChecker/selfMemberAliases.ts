import type { TypeAliasEntry, VariableType } from "../types.js";

/**
 * Whether the alias `name` lists itself as a member of its own union,
 * directly or through other aliases:
 *
 *     type A = number | A
 *
 *     type B = C | number
 *     type C = B | string
 *
 * Such a type has no meaning, and resolving it never ends. An alias may
 * refer to itself inside a structure, as `type Tree = { kids: Tree[] }` and
 * `type Json = string | Json[]` do. Those are not reported: the walk follows
 * union members and alias names only, and stops at any other type.
 */
export function aliasIsItsOwnMember(
  name: string,
  aliases: Record<string, TypeAliasEntry>,
): boolean {
  const entry = ownEntry(aliases, name);
  if (entry === undefined) {
    return false;
  }
  const pending: VariableType[] = [entry.body];
  const followed: string[] = [];
  while (pending.length > 0) {
    const type = pending.shift()!;
    if (type.type === "unionType") {
      pending.push(...type.types);
      continue;
    }
    const referenced = aliasNamedBy(type);
    if (referenced === name) {
      return true;
    }
    const next = referenced === undefined ? undefined : ownEntry(aliases, referenced);
    if (referenced === undefined || next === undefined || followed.includes(referenced)) {
      continue;
    }
    followed.push(referenced);
    pending.push(next.body);
  }
  return false;
}

/** The entry for `name`, never a key from the object prototype: a type may
 *  be named `toString`. */
function ownEntry(
  aliases: Record<string, TypeAliasEntry>,
  name: string,
): TypeAliasEntry | undefined {
  return Object.hasOwn(aliases, name) ? aliases[name] : undefined;
}

/** The alias a type stands for as a whole: `A`, or the `A` of `A<number>`. */
function aliasNamedBy(type: VariableType): string | undefined {
  if (type.type === "typeAliasVariable") {
    return type.aliasName;
  }
  if (type.type === "genericType") {
    return type.name;
  }
  return undefined;
}
