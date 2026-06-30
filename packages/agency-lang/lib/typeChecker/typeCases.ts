import type { VariableType, TypeAliasEntry } from "../types.js";
import { safeResolveType } from "./assignability.js";

export type TypeCase =
  | { kind: "resultSuccess" }
  | { kind: "resultFailure" }
  | { kind: "member"; type: VariableType }
  | { kind: "literal"; value: string | number | boolean };

export type CaseSet = { cases: TypeCase[]; closed: boolean };

const OPEN: CaseSet = { cases: [], closed: false };

function literalCase(t: VariableType): TypeCase | null {
  if (t.type === "stringLiteralType") return { kind: "literal", value: t.value };
  if (t.type === "numberLiteralType") return { kind: "literal", value: Number(t.value) };
  if (t.type === "booleanLiteralType") return { kind: "literal", value: t.value === "true" };
  return null;
}

/**
 * Enumerate the cases of a value type for exhaustiveness / future narrowing.
 * `closed: false` means the type is open (string/number/any, a union containing
 * `any`, an effect set, or any unrecognized shape) — exhaustiveness can only be
 * satisfied by a `_` arm, never required. Effect sets are deliberately open here:
 * their enumeration belongs to `resolveEffectSet` (handler-narrowing spec).
 */
export function decomposeCases(
  type: VariableType | "any",
  aliases: Record<string, TypeAliasEntry>,
): CaseSet {
  if (type === "any") return OPEN;
  // safeResolveType yields ANY_T (a primitiveType "any"), never the string
  // "any"; an unresolved/any type falls through to the default OPEN below.
  const resolved = safeResolveType(type, aliases);

  if (resolved.type === "resultType") {
    // B1: the two Result branches as bespoke cases (the spec sanctions this; B2
    // can route through resultToObjectUnion when member-coverage lands — not
    // imported here to avoid a dead import).
    return { cases: [{ kind: "resultSuccess" }, { kind: "resultFailure" }], closed: true };
  }

  if (resolved.type === "unionType") {
    if (resolved.isEffectSet) return OPEN; // owned by resolveEffectSet, never re-walked
    const cases: TypeCase[] = [];
    for (const member of resolved.types) {
      const rm = safeResolveType(member, aliases);
      if (rm.type === "primitiveType" && rm.value === "any") {
        return OPEN; // a union with an open member can't be required to be exhaustive
      }
      // A nested unionType member is deliberately pushed as a single `member`
      // case (not flattened): checkSite then skips the whole match (member ⇒ no
      // diagnostic), which is sound. Don't "fix" this by recursing without
      // re-checking the coverage implications.
      const litC = literalCase(rm);
      cases.push(litC ?? { kind: "member", type: rm });
    }
    return { cases, closed: true };
  }

  // primitives (string/number/boolean/…), objectType, generics, etc. → open.
  // NOTE: `boolean` is open here — it is NOT enumerated as `true | false`. Only
  // a literal union (`true | false` written explicitly) decomposes to literals.
  return OPEN;
}
