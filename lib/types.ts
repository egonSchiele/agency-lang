export type Literal = NumberLiteral | StringLiteral | VariableNameLiteral | PromptLiteral;

export interface NumberLiteral {
  type: "number";
  value: string;
}

export interface StringLiteral {
  type: "string";
  value: string;
}

export interface VariableNameLiteral {
  type: "variableName";
  value: string;
}

export interface PromptLiteral {
  type: "prompt";
  text: string;
}

export interface Assignment {
  type: "assignment";
  variableName: string;
  value: Literal;
}

export interface FunctionDefinition {
  type: "function";
  functionName: string;
  body: Array<Assignment | Literal>;
}

export interface TypeHint {
  type: "typeHint";
  variableName: string;
  variableType: string;
}

export type ADLNode = TypeHint | FunctionDefinition | Assignment | Literal;

export type ADLProgram = {
  type: "adlProgram";
  nodes: ADLNode[];
}