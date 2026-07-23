import {
  AgencyArray,
  AgencyNode,
  AgencyObject,
  AgencyObjectKV,
  BooleanLiteral,
  Expression,
  NullLiteral,
  NumberLiteral,
  StringLiteral,
} from "../../types.js";
import { SourceLocation } from "../../types/base.js";

/**
 * Typed constructors for literal AST nodes, so the node shapes have one
 * owner instead of being hand-assembled with casts through the lifter.
 * Shapes match what the parser produces (verified against `pnpm run ast`
 * output; see lib/parsers/literals.test.ts for the string shape).
 */

export function stringLiteral(value: string, loc: SourceLocation): StringLiteral {
  return {
    type: "string",
    segments: [{ type: "text", value }],
    delimiter: '"',
    loc,
  };
}

export function numberLiteral(value: number, loc: SourceLocation): NumberLiteral {
  return { type: "number", value: String(value), loc };
}

export function booleanLiteral(value: boolean, loc: SourceLocation): BooleanLiteral {
  return { type: "boolean", value, loc };
}

export function nullLiteral(loc: SourceLocation): NullLiteral {
  return { type: "null", loc };
}

export function arrayLiteral(items: AgencyNode[], loc: SourceLocation): AgencyArray {
  return { type: "agencyArray", items: items as Expression[], loc };
}

export function objectLiteral(
  entries: { key: string; value: AgencyNode }[],
  loc: SourceLocation,
): AgencyObject {
  return {
    type: "agencyObject",
    entries: entries.map(
      ({ key, value }): AgencyObjectKV => ({ key, value: value as Expression }),
    ),
    loc,
  };
}
