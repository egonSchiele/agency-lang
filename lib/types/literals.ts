import { ScopeType } from "@/types.js";
import { ValueAccess } from "./access.js";

export type Literal =
  | NumberLiteral
  | MultiLineStringLiteral
  | StringLiteral
  | VariableNameLiteral
  | BooleanLiteral;

export type NumberLiteral = {
  type: "number";
  value: string;
};

export type StringLiteral = {
  type: "string";
  segments: PromptSegment[];
};

export type MultiLineStringLiteral = {
  type: "multiLineString";
  segments: PromptSegment[];
};

export type VariableNameLiteral = {
  type: "variableName";
  value: string;
  scope?: ScopeType;
  async?: boolean;
};

export type BooleanLiteral = {
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
  expression: VariableNameLiteral | ValueAccess;
};

export type RawCode = {
  type: "rawCode";
  value: string;
};
