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

export type Assignment = {
  type: "assignment";
  variableName: string;
  value: Literal;
};

export type FunctionDefinition = {
  type: "function";
  functionName: string;
  body: Array<Assignment | Literal>;
};

export type TypeHint = {
  type: "typeHint";
  variableName: string;
  variableType: VariableType;
};

export type VariableType = PrimitiveType | ArrayType;

export type PrimitiveType = {
  type: "primitiveType";
  value: string;
};

export type ArrayType = {
  type: "arrayType";
  elementType: VariableType;
};

export type FunctionCall = {
  type: "functionCall";
  functionName: string;
  arguments: string[];
};

export type ADLNode =
  | TypeHint
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall;

export type ADLProgram = {
  type: "adlProgram";
  nodes: ADLNode[];
};
