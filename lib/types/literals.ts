import { AgencyObject } from "./dataStructures.js";
import { UsesTool } from "./tools.js";

export type Literal =
  | NumberLiteral
  | MultiLineStringLiteral
  | StringLiteral
  | VariableNameLiteral
  | PromptLiteral

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
};

// New types for prompt segments
export type PromptSegment = TextSegment | InterpolationSegment;

export type TextSegment = {
  type: "text";
  value: string;
};

export type InterpolationSegment = {
  type: "interpolation";
  variableName: string;
};

export type PromptLiteral = {
  type: "prompt";
  segments: PromptSegment[];
  config?: AgencyObject;
  isStreaming?: boolean;
  async?: boolean;
  tools?: UsesTool;
};

export type RawCode = {
  type: "rawCode";
  value: string;
};
