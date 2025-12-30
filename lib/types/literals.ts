export type Literal =
  | NumberLiteral
  | StringLiteral
  | VariableNameLiteral
  | PromptLiteral;

export type NumberLiteral = {
  type: "number";
  value: string;
};

export type StringLiteral = {
  type: "string";
  value: string;
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
};
