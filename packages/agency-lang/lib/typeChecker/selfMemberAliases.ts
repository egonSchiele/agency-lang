import type { TypeAliasEntry, VariableType } from "../types.js";
import { substituteTypeParams } from "./substitute.js";

/** How many alias references one walk follows before it gives up. A chain
 *  this long is generic aliases that instantiate each other without end,
 *  which no later walk could resolve either. */
const MAX_REFERENCES_FOLLOWED = 500;

/**
 * Whether the alias `name` lists itself as a member of its own union,
 * directly or through other aliases:
 *
 *     type A = number | A
 *
 *     type B = C | number
 *     type C = B | string
 *
 *     type Maybe<T> = T | null
 *     type D = number | Maybe<D>
 *
 * Such a type has no meaning, and resolving it never ends. An alias may
 * refer to itself inside a structure, as `type Tree = { kids: Tree[] }` and
 * `type Json = string | Json[]` do. Those are not reported: the walk follows
 * union members and alias names only, and stops at any other type.
 *
 * A reference to a generic alias is followed with its type arguments put
 * into the alias body. That is how `Maybe<D>` above is seen as `D | null`,
 * while `List<D>` with `type List<T> = { items: T[] }` is not followed into
 * `D`, because the parameter sits inside a structure.
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
    const key = JSON.stringify(type, (field, value) => (field === "loc" ? undefined : value));
    if (next === undefined || followed.includes(key)) {
      continue;
    }
    if (followed.length >= MAX_REFERENCES_FOLLOWED) {
      return true;
    }
    followed.push(key);
    pending.push(bodyWithArguments(type, next));
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

/** The body of the alias `reference` names, with the reference's type
 *  arguments in place of the alias's parameters. A parameter with no
 *  argument takes its default, or stays as its own name. */
function bodyWithArguments(reference: VariableType, entry: TypeAliasEntry): VariableType {
  const params = entry.typeParams ?? [];
  if (params.length === 0) {
    return entry.body;
  }
  const given = reference.type === "genericType" ? reference.typeArgs : [];
  const args = params.map(
    (param, index): VariableType =>
      given[index] ?? param.default ?? { type: "typeAliasVariable", aliasName: param.name },
  );
  return substituteTypeParams(
    entry.body,
    params.map((param) => param.name),
    args,
  );
}
