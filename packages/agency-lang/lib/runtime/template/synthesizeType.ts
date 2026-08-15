import { isCode, kindOf, type Code } from "./code.js";
import { typeKey } from "../../typeChecker/typeKey.js";
import { ANY_T, BOOLEAN_T, NULL_T, NUMBER_T, STRING_T } from "../../typeChecker/primitives.js";
import type { StringLiteral, VariableType } from "../../types.js";

export type SynthesizeOptions = {
  /**
   * Describe a string as its literal type (`"fast"`) rather than `string`.
   *
   * Off by default: a large array of distinct strings would become an
   * equally large union. On for `assertFillerType`'s second pass, which
   * only runs on a fill already headed for rejection.
   *
   * Numbers and booleans stay widened in BOTH modes, mirroring `synthType`
   * — the compile rejects `const n: 1 | 2 = 1`, so describing them
   * literally would make fill accept what the compile refuses.
   */
  stringsAsLiterals?: boolean;
};

/**
 * The type of a plain runtime value, or null when it cannot be known.
 *
 * Null means "do not check", never "reject": a guess here would reject
 * correct programs, and the completed program's compile is the backstop.
 * The result shares structure with the primitive singletons, so treat it
 * as read-only.
 *
 * THREE-WAY AGREEMENT. `liftValue` decides what a value BECOMES, this
 * decides what type fill SAYS it has, and the checker's `synthType`
 * decides what the compile INFERS for what it became. Drift either stops
 * fill checking (invisible) or rejects values that compile (see the
 * invariant on `assertFillerType`). Today that means mirroring `synthType`:
 * string literals stay literal, numbers and booleans widen.
 */
export function synthesizeType(
  value: unknown,
  options: SynthesizeOptions = {},
): VariableType | null {
  if (value === null || value === undefined) return NULL_T;
  if (typeof value === "string") {
    return options.stringsAsLiterals === true ? { type: "stringLiteralType", value } : STRING_T;
  }
  if (typeof value === "number") return NUMBER_T;
  if (typeof value === "boolean") return BOOLEAN_T;
  // Before the object branch: a Code value is an object too.
  if (isCode(value)) return literalFragmentType(value, options);
  if (Array.isArray(value)) return arrayTypeOf(value, options);
  // Plain objects only: describing a Date or Map by its enumerable keys
  // would produce a type that rejects, the opposite of skipping.
  if (isPlainObject(value)) {
    return objectTypeOf(value as Record<string, unknown>, options);
  }
  return null;
}

/** Built by an object literal or `JSON.parse`, not by a constructor. */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A fragment holding exactly one uninterpolated literal, and nothing else.
 *  An interpolated string could render anything the generated program's
 *  scope produces, so it stays unknowable in both directions.
 *
 *  Honors `stringsAsLiterals` for the same reason a plain string does: the
 *  graft becomes the literal `"fast"`, which the compile infers as a
 *  string-literal type. */
function literalFragmentType(code: Code, options: SynthesizeOptions): VariableType | null {
  if (kindOf(code) !== "expr" || code.nodes.length !== 1) return null;
  const node = code.nodes[0];
  if (node.type === "number") return NUMBER_T;
  if (node.type === "boolean") return BOOLEAN_T;
  if (node.type === "string") {
    const literal = node as StringLiteral;
    const interpolated = literal.segments.some((segment) => segment.type === "interpolation");
    if (interpolated) return null;
    // Mirrors `literalToType`'s eligibility (one text segment); anything
    // else widens, as `synthType` does when `literalToType` declines.
    const first = literal.segments[0];
    if (
      options.stringsAsLiterals === true &&
      literal.segments.length === 1 &&
      first.type === "text"
    ) {
      return { type: "stringLiteralType", value: first.value };
    }
    return STRING_T;
  }
  return null;
}

/** Members are deduplicated by canonical key, so a homogeneous array of
 *  1000 records yields one member. Dedupe rather than sampling: sampling
 *  would depend on where an odd element sat. */
function arrayTypeOf(value: unknown[], options: SynthesizeOptions): VariableType | null {
  const members: VariableType[] = [];
  // Keys come from user data, so the seen-set is null-prototype and
  // membership goes through Object.hasOwn (house pattern).
  const seen: Record<string, true> = Object.create(null);
  for (const item of value) {
    const member = synthesizeType(item, options);
    // One unknowable element makes the array unknowable: a union missing a
    // member would reject values that are fine.
    if (member === null) return null;
    const key = typeKey(member, {});
    if (Object.hasOwn(seen, key)) continue;
    seen[key] = true;
    members.push(member);
  }
  if (members.length === 0) return { type: "arrayType", elementType: ANY_T };
  return {
    type: "arrayType",
    elementType: members.length === 1 ? members[0] : { type: "unionType", types: members },
  };
}

function objectTypeOf(
  value: Record<string, unknown>,
  options: SynthesizeOptions,
): VariableType | null {
  const properties: { key: string; value: VariableType }[] = [];
  for (const key of Object.keys(value)) {
    const propertyType = synthesizeType(value[key], options);
    if (propertyType === null) return null;
    properties.push({ key, value: propertyType });
  }
  return { type: "objectType", properties };
}
