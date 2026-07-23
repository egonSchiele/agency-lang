import { AgencyNode } from "../../types.js";
import { SourceLocation } from "../../types/base.js";
import {
  arrayLiteral,
  booleanLiteral,
  nullLiteral,
  numberLiteral,
  objectLiteral,
  stringLiteral,
} from "./literals.js";

/**
 * Turn a plain runtime value into a literal AST node.
 *
 * This function must NEVER parse. A string becomes a string literal
 * containing exactly those characters — that is what stops a filler from
 * injecting code into a generated program.
 */
export function liftValue(value: unknown, loc: SourceLocation): AgencyNode {
  if (value === null || value === undefined) return nullLiteral(loc);
  if (typeof value === "string") return stringLiteral(value, loc);
  if (typeof value === "number") return numberLiteral(value, loc);
  if (typeof value === "boolean") return booleanLiteral(value, loc);
  if (Array.isArray(value)) {
    return arrayLiteral(value.map((item) => liftValue(item, loc)), loc);
  }
  if (typeof value === "object") {
    return objectLiteral(
      Object.keys(value as object).map((key) => ({
        key,
        value: liftValue((value as Record<string, unknown>)[key], loc),
      })),
      loc,
    );
  }
  throw new Error(`Cannot lift a value of type ${typeof value} into a template.`);
}
