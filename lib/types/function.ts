import { AgencyNode } from "../types.js";
import { AccessExpression } from "./access.js";
import { Literal } from "./literals.js";

export type FunctionDefinition = {
  type: "function";
  functionName: string;
  parameters: string[];
  body: AgencyNode[];
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
