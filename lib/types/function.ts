import {
  AgencyNode,
  Expression,
  Literal,
  VariableType,
} from "../types.js";
import { BaseNode } from "./base.js";
import { AgencyArray, AgencyObject, NamedArgument, SplatExpression } from "./dataStructures.js";
import { UsesTool } from "./tools.js";

export type FunctionParameter = {
  type: "functionParameter";
  name: string;
  typeHint?: VariableType;
  variadic?: boolean;
  defaultValue?: Literal | AgencyArray | AgencyObject;
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
  arguments: (Expression | SplatExpression | NamedArgument)[];
  async?: boolean;
  tools?: UsesTool;
};

export type DocString = {
  type: "docString";
  value: string;
};
