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

export type PromptLiteral = {
  type: "prompt";
  text: string;
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
  variableType: string;
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
