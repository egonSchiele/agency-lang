import { AgencyNode, VariableType } from "../types.js";
import { AccessExpression } from "./access.js";
import { Literal } from "./literals.js";

export type FunctionParameter = {
  type: "functionParameter";
  name: string;
  typeHint?: VariableType;
};

export type FunctionDefinition = {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType;
  docString?: DocString;
};

export type FunctionCall = {
  type: "functionCall";
  functionName: string;
  arguments: (Literal | AccessExpression | FunctionCall)[];
};

export type DocString = {
  type: "docString";
  value: string;
};
