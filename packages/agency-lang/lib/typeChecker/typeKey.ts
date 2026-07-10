import type { Expression, TypeAliasEntry, VariableType } from "../types.js";
import { safeResolveType } from "./assignability.js";

/**
 * Canonical structural identity for a type — THE replacement for raw
 * `JSON.stringify(t)` at identity sites (uniteTypes, loop widening, union
 * dedup in synthesis, coinduction pair keys). Fixes the gaps raw stringify
 * had (issue #473): property-order sensitivity, non-semantic metadata
 * leaking into the key, and unresolved top-level aliases keying
 * differently from their bodies.
 *
 * Deliberate identity decisions (all safe because the consumers feed
 * dedup/diagnostics and cycle detection, never codegen schemas):
 * - The TOP node resolves ONE step via safeResolveType (recursive
 *   self-refs stay nominal via its guard); NESTED alias refs key
 *   nominally as `alias:Name` — never expanded, so recursion terminates
 *   and same-name refs always key equal.
 * - `valueArgs` ARE identity: `Age(18)` and `Age(21)` are different types.
 * - `tags`, `trivia`, property `description`s, `loc`, `isEffectSet`, and
 *   `blockType.raises` are NOT identity: two types differing only in
 *   annotations/formatting dedup together (first member's metadata wins
 *   at union joins — acceptable for diagnostics).
 * - Union members sort by canonical form (`A | B` keys equal `B | A`);
 *   object properties sort by key.
 */
export function typeKey(
  t: VariableType,
  aliases: Record<string, TypeAliasEntry>,
): string {
  return canonical(safeResolveType(t, aliases));
}

/**
 * Canonicalize a tag-argument-subset expression (literals, identifiers,
 * object literals) for valueArgs identity. A loc-stripped JSON walk —
 * stable, if verbose; the subset is small and rarely deep.
 */
function canonicalExpr(e: Expression): string {
  return JSON.stringify(e, (key, value) =>
    key === "loc" ? undefined : value,
  );
}

function canonicalValueArgs(valueArgs: Expression[] | undefined): string {
  if (!valueArgs || valueArgs.length === 0) return "";
  return `,"vargs":[${valueArgs.map(canonicalExpr).join(",")}]`;
}

function canonical(t: VariableType): string {
  switch (t.type) {
    case "typeAliasVariable":
      return `{"alias":${JSON.stringify(t.aliasName)}${canonicalValueArgs(t.valueArgs)}}`;
    case "objectType": {
      // Render each property first, then sort the strings — same pattern
      // as the union case. Each rendered string starts with the quoted
      // key, so the sort is effectively by key.
      const props = t.properties
        .map((p) => `${JSON.stringify(p.key)}:${canonical(p.value)}`)
        .sort();
      return `{"object":{${props.join(",")}}}`;
    }
    case "unionType":
      return `{"union":[${t.types.map(canonical).sort().join(",")}]}`;
    case "arrayType":
      return `{"array":${canonical(t.elementType)}}`;
    case "resultType":
      return `{"result":[${canonical(t.successType)},${canonical(t.failureType)}]}`;
    case "schemaType":
      return `{"schema":${canonical(t.inner)}}`;
    case "genericType":
      return `{"generic":${JSON.stringify(t.name)},"args":[${t.typeArgs.map(canonical).join(",")}]${canonicalValueArgs(t.valueArgs)}}`;
    case "blockType":
      return `{"block":[${t.params.map((p) => canonical(p.typeAnnotation)).join(",")}],"ret":${canonical(t.returnType)}}`;
    case "functionRefType":
      return `{"fnref":${JSON.stringify(t.name)}}`;
    case "primitiveType":
      return `{"prim":${JSON.stringify(t.value)}}`;
    case "stringLiteralType":
      return `{"strlit":${JSON.stringify(t.value)}}`;
    case "numberLiteralType":
      return `{"numlit":${JSON.stringify(t.value)}}`;
    case "booleanLiteralType":
      return `{"boollit":${JSON.stringify(t.value)}}`;
    default: {
      // Exhaustiveness enforced per the typeHints.ts convention: a new
      // VariableType variant fails compilation here instead of silently
      // returning undefined.
      const exhausted: never = t;
      throw new Error(
        `typeKey: unhandled type variant ${JSON.stringify(exhausted)}`,
      );
    }
  }
}
