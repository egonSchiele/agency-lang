import type { VariableType, TypeAliasEntry } from "../types.js";
import { safeResolveType } from "./assignability.js";
import { unescapeStringLiteralValue } from "../parsers/parsers.js";

export type TypeCase =
  | { kind: "resultSuccess" }
  | { kind: "resultFailure" }
  | { kind: "member"; type: VariableType; disc?: { prop: string; value: string | number | boolean } }
  | { kind: "literal"; value: string | number | boolean };

export type CaseSet = { cases: TypeCase[]; closed: boolean };

const OPEN: CaseSet = { cases: [], closed: false };

/**
 * The literal value of a `*LiteralType`, or null for a non-literal type. THE
 * single type-side literal extractor (used by `literalCase` and
 * `findDiscriminant`). Unescape so a string-literal TYPE value (stored escaped,
 * e.g. `a\nb`) keys identically to a match arm's text value (a real newline) —
 * see matchExhaustiveness.armLiteral / asStaticLiteral.
 */
function literalValue(t: VariableType): string | number | boolean | null {
  if (t.type === "stringLiteralType") return unescapeStringLiteralValue(t.value);
  if (t.type === "numberLiteralType") return Number(t.value);
  if (t.type === "booleanLiteralType") return t.value === "true";
  return null;
}

function literalCase(t: VariableType): TypeCase | null {
  const v = literalValue(t);
  return v === null ? null : { kind: "literal", value: v };
}

type Discriminant = { prop: string; values: (string | number | boolean)[] };

/**
 * A union is DISCRIMINATED on property `p` iff every member resolves to an
 * objectType with `p` typed as a string/number/boolean LITERAL, and those
 * literals are pairwise DISTINCT (a value uniquely selects a member). Returns
 * the first such property in member-0's declaration order (advancing past
 * candidates whose values collide), or null. Exhaustiveness must DETECT the
 * discriminant (narrowing is told it by the condition).
 */
function findDiscriminant(
  members: VariableType[],
  aliases: Record<string, TypeAliasEntry>,
): Discriminant | null {
  const first = safeResolveType(members[0], aliases);
  if (first.type !== "objectType") return null;
  for (const cand of first.properties) {
    if (literalValue(safeResolveType(cand.value, aliases)) === null) continue;
    const values: (string | number | boolean)[] = [];
    let ok = true;
    for (const m of members) {
      const rm = safeResolveType(m, aliases);
      if (rm.type !== "objectType") { ok = false; break; }
      const pv = rm.properties.find((p) => p.key === cand.key)?.value;
      const lv = pv ? literalValue(safeResolveType(pv, aliases)) : null;
      if (lv === null) { ok = false; break; }
      values.push(lv);
    }
    if (ok && new Set(values.map((v) => `${typeof v}:${String(v)}`)).size === members.length) {
      return { prop: cand.key, values };
    }
  }
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
    const members = resolved.types.map((m) => safeResolveType(m, aliases));
    if (members.some((rm) => rm.type === "primitiveType" && rm.value === "any")) {
      return OPEN; // a union with an open member can't be required to be exhaustive
    }
    // B2: a union whose members are all literal-tagged, distinct-valued objects
    // is discriminated — tag each member case so `matchExhaustiveness` can map
    // `{ tag: literal }` arms. Otherwise members stay opaque (B1). A nested
    // unionType member isn't an objectType, so `findDiscriminant` returns null
    // and it stays a single opaque `member` case (sound; don't flatten).
    const disc = findDiscriminant(members, aliases);
    const cases: TypeCase[] = members.map((rm, i) => {
      const litC = literalCase(rm);
      if (litC) return litC;
      // Destructure after the null-check — no `disc!` non-null assertion.
      return disc === null
        ? { kind: "member", type: rm }
        : { kind: "member", type: rm, disc: { prop: disc.prop, value: disc.values[i] } };
    });
    return { cases, closed: true };
  }

  // A bare `boolean` is a closed two-case type. Coverage rides B1's literal-arm
  // path (a `true`/`false` arm → a `literal` case).
  if (resolved.type === "primitiveType" && resolved.value === "boolean") {
    return { cases: [{ kind: "literal", value: true }, { kind: "literal", value: false }], closed: true };
  }

  // Other primitives (string/number/…), objectType, generics, etc. → open.
  return OPEN;
}
