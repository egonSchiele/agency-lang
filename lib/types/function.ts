import {
  AgencyNode,
  Expression,
  VariableType,
} from "../types.js";
import { BaseNode } from "./base.js";
import { UsesTool } from "./tools.js";

export type FunctionParameter = {
  type: "functionParameter";
  name: string;
  typeHint?: VariableType;
};

export type FunctionDefinition = BaseNode & {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  docString?: DocString;
  async?: boolean;
  safe?: boolean;
};

export type FunctionCall = BaseNode & {
  type: "functionCall";
  functionName: string;
  arguments: Expression[];
  async?: boolean;
  tools?: UsesTool;
};

export type DocString = {
  type: "docString";
  value: string;
};
