import { Expression, ScopeType } from "@/types.js";
import { BaseNode } from "./base.js";

export type Literal =
  | NumberLiteral
  | MultiLineStringLiteral
  | StringLiteral
  | VariableNameLiteral
  | BooleanLiteral;

export type NumberLiteral = BaseNode & {
  type: "number";
  value: string;
};

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

export type RawCode = BaseNode & {
  type: "rawCode";
  value: string;
};
