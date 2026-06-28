import type { Expression } from "../types.js";
import type {
  StringLiteralType,
  NumberLiteralType,
  BooleanLiteralType,
} from "../types/typeHints.js";

/** Convert a literal expression to its literal type, or null if not a simple
 *  literal. Single source of truth — `synthType`'s string-literal case also
 *  uses it, and the discriminant-narrowing recognizer uses the numeric/boolean
 *  cases. Note: `synthType` deliberately does NOT route its number/boolean
 *  cases here (those stay `NUMBER_T`/`BOOLEAN_T`); only the recognizer needs
 *  literal types for `number`/`boolean`. */
export function literalToType(
  e: Expression,
): StringLiteralType | NumberLiteralType | BooleanLiteralType | null {
  if (e.type === "string" && e.segments.length === 1 && e.segments[0].type === "text") {
    return { type: "stringLiteralType", value: e.segments[0].value };
  }
  if (e.type === "number") {
    return { type: "numberLiteralType", value: e.value };
  }
  if (e.type === "boolean") {
    return { type: "booleanLiteralType", value: e.value ? "true" : "false" };
  }
  return null;
}
