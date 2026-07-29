import { isCode, kindOf, type Code } from "./code.js";
import { typeKey } from "../../typeChecker/typeKey.js";
import {
  ANY_T,
  BOOLEAN_T,
  NULL_T,
  NUMBER_T,
  STRING_T,
} from "../../typeChecker/primitives.js";
import type { StringLiteral, VariableType } from "../../types.js";

export type SynthesizeOptions = {
  /**
   * Describe a string as its literal type (`"fast"`) rather than as
   * `string`.
   *
   * Off by default because a large array of distinct strings would become
   * an equally large union. On for the second pass in `assertFillerType`,
   * which runs only when the widened pass has already decided to reject —
   * so the cost lands only on a fill that was about to throw.
   *
   * Numbers and booleans stay widened in BOTH modes, mirroring `synthType`
   * (`lib/typeChecker/synthesizer.ts`): the compile rejects
   * `const n: 1 | 2 = 1`, so accepting it here would be drift in the other
   * direction.
   */
  stringsAsLiterals?: boolean;
};

/**
 * The type of a plain runtime value, or null when it cannot be known.
 *
 * Null means "do not check", never "reject". Fills run at run time on
 * model-supplied data, so a guess here would reject correct programs; the
 * completed program's own compile is the backstop for everything this
 * declines to describe.
 *
 * Absorbs what `certainTypeOf` used to do for single-literal fragments —
 * that check predates this function and must not be lost. Moving it here
 * also makes it alias-aware for free, since the caller now resolves the
 * expected type instead of string-matching it.
 *
 * The result may share structure with the shared primitive singletons
 * (`STRING_T` and friends), so treat it as read-only. Nothing should ever
 * mutate a synthesized type.
 *
 * THREE-WAY AGREEMENT, and the reason this file needs care. `liftValue`
 * decides what a value BECOMES in the generated program. This function
 * decides what type fill SAYS it has. The checker's `synthType` decides
 * what type the compile INFERS for what it became. If those three drift
 * apart, fill either stops checking things (harmless, and invisible) or
 * rejects values that compile fine (not harmless — see the design
 * invariant in `assertFillerType`). The mirroring that matters today:
 * `synthType` infers a plain string as a string-literal type and leaves
 * numbers and booleans widened, which is what `stringsAsLiterals` exists
 * to reproduce. Verified: `const mode: "fast" | "slow" = "fast"` compiles,
 * `const n: 1 | 2 = 1` does not.
 */
export function synthesizeType(
  value: unknown,
  options: SynthesizeOptions = {},
): VariableType | null {
  if (value === null || value === undefined) return NULL_T;
  if (typeof value === "string") {
    return options.stringsAsLiterals === true
      ? { type: "stringLiteralType", value }
      : STRING_T;
  }
  if (typeof value === "number") return NUMBER_T;
  if (typeof value === "boolean") return BOOLEAN_T;
  // Before the object branch: a Code value is an object, and describing it
  // as a record of its own internals would be nonsense.
  if (isCode(value)) return literalFragmentType(value, options);
  if (Array.isArray(value)) return arrayTypeOf(value, options);
  // Plain objects only. A Date, Map, Set or class instance is an object to
  // `typeof`, and describing one as a record of its own enumerable keys
  // would produce a type that rejects — the opposite of skipping.
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
 *  Honors `stringsAsLiterals` for the same reason a plain string does: a
 *  grafted `[| "fast" |]` becomes the literal `"fast"` in the generated
 *  program, and the compile infers a string-literal type for it exactly as
 *  it would for a plain-value fill. Widening here regardless would reject
 *  `[| "fast" |]` against a `"fast" | "slow"` hole that compiles fine. */
function literalFragmentType(
  code: Code,
  options: SynthesizeOptions,
): VariableType | null {
  if (kindOf(code) !== "expr" || code.nodes.length !== 1) return null;
  const node = code.nodes[0];
  if (node.type === "number") return NUMBER_T;
  if (node.type === "boolean") return BOOLEAN_T;
  if (node.type === "string") {
    const literal = node as StringLiteral;
    const interpolated = literal.segments.some(
      (segment) => segment.type === "interpolation",
    );
    if (interpolated) return null;
    // Mirrors `literalToType`'s own eligibility condition (a single text
    // segment); anything else widens, which is what `synthType` does when
    // `literalToType` declines.
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

/** Member types are deduplicated by canonical key, so a homogeneous array
 *  of 1000 records yields one member rather than 1000. Dedupe rather than
 *  sampling a prefix: sampling would make the answer depend on where an
 *  odd element happened to sit. */
function arrayTypeOf(
  value: unknown[],
  options: SynthesizeOptions,
): VariableType | null {
  const members: VariableType[] = [];
  // Keys come from user data, so the seen-set is null-prototype and
  // membership goes through Object.hasOwn (house pattern).
  const seen: Record<string, true> = Object.create(null);
  for (const item of value) {
    const member = synthesizeType(item, options);
    // One unknowable element makes the whole array unknowable: a union
    // missing a member would reject values that are actually fine.
    if (member === null) return null;
    const key = typeKey(member, {});
    if (Object.hasOwn(seen, key)) continue;
    seen[key] = true;
    members.push(member);
  }
  if (members.length === 0) return { type: "arrayType", elementType: ANY_T };
  return {
    type: "arrayType",
    elementType:
      members.length === 1 ? members[0] : { type: "unionType", types: members },
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
