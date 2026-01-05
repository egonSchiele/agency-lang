import { AgencyNode } from "@/types";
import { AccessExpression } from "./access";
import { Literal } from "./literals";

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
