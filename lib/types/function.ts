import { ADLNode } from "@/types";
import { AccessExpression } from "./access";
import { Literal } from "./literals";

export type FunctionDefinition = {
  type: "function";
  functionName: string;
  parameters: string[];
  body: ADLNode[];
  docString?: DocString;
};

export type FunctionCall = {
  type: "functionCall";
  functionName: string;
  arguments: (Literal | AccessExpression | FunctionCall)[];
};

export type ReturnStatement = {
  type: "returnStatement";
  value: ADLNode;
};

export type DocString = {
  type: "docString";
  value: string;
};
