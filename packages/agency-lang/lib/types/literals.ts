import { Expression, ScopeType } from "@/types.js";
import { BaseNode } from "./base.js";

export type Literal =
  | NumberLiteral
  | UnitLiteral
  | MultiLineStringLiteral
  | StringLiteral
  | VariableNameLiteral
  | BooleanLiteral
  | NullLiteral;

export type NumberLiteral = BaseNode & {
  type: "number";
  value: string;
};

export type TimeUnitLiteral = BaseNode & {
  type: "unitLiteral";
  value: string;
  unit: "ms" | "s" | "m" | "h" | "d" | "w";
  canonicalValue: number;
  dimension: "time";
};

export type CostUnitLiteral = BaseNode & {
  type: "unitLiteral";
  value: string;
  unit: "$";
  canonicalValue: number;
  dimension: "cost";
};

export type ByteUnitLiteral = BaseNode & {
  type: "unitLiteral";
  value: string;
  unit: "b" | "kb" | "mb" | "gb";
  canonicalValue: number;
  dimension: "bytes";
};

export type UnitLiteral = TimeUnitLiteral | CostUnitLiteral | ByteUnitLiteral;

export function formatUnitLiteral(lit: Pick<UnitLiteral, "value" | "unit">): string {
  return lit.unit === "$" ? `$${lit.value}` : `${lit.value}${lit.unit}`;
}

export type StringLiteral = BaseNode & {
  type: "string";
  segments: PromptSegment[];
};

export type MultiLineStringLiteral = BaseNode & {
  type: "multiLineString";
  segments: PromptSegment[];
};

export type VariableNameLiteral = BaseNode & {
  type: "variableName";
  value: string;
  scope?: ScopeType;
  async?: boolean;
};

export type BooleanLiteral = BaseNode & {
  type: "boolean";
  value: boolean;
};

export type NullLiteral = BaseNode & {
  type: "null";
};

// New types for prompt segments
export type PromptSegment = TextSegment | InterpolationSegment;

export type TextSegment = {
  type: "text";
  value: string;
};

export type InterpolationSegment = {
  type: "interpolation";
  expression: Expression;
};

export type RegexLiteral = BaseNode & {
  type: "regex";
  pattern: string;
  flags: string;
};

export type RawCode = BaseNode & {
  type: "rawCode";
  value: string;
};
