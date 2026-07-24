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
  if (typeof value === "number") {
    // No Agency literal exists for non-finite numbers: `Infinity` and
    // `NaN` would print as bare identifier tokens and re-parse as NAME
    // REFERENCES, silently binding to whatever those names mean in the
    // generated program. Reachable from ordinary model output —
    // JSON.parse("1e400") is Infinity — so reject loudly.
    if (!Number.isFinite(value)) {
      throw new Error(
        `Cannot lift the non-finite number ${value} into a template — Agency has no literal for it.`,
      );
    }
    return numberLiteral(value, loc);
  }
  if (typeof value === "boolean") return booleanLiteral(value, loc);
  if (Array.isArray(value)) {
    return arrayLiteral(value.map((item) => liftValue(item, loc)), loc);
  }
  if (typeof value === "object") {
    return objectLiteral(
      Object.keys(value as object).map((key) => {
        // In a JS object literal, a `__proto__` key — even quoted — sets
        // the prototype instead of creating an own property. A lifted
        // model-supplied record must never smuggle that in, so reject it
        // loudly rather than emit a literal whose shape silently differs
        // from the data.
        if (key === "__proto__") {
          throw new Error(
            `Cannot lift an object with a "__proto__" key into a template.`,
          );
        }
        return {
          key,
          value: liftValue((value as Record<string, unknown>)[key], loc),
        };
      }),
      loc,
    );
  }
  throw new Error(`Cannot lift a value of type ${typeof value} into a template.`);
}
