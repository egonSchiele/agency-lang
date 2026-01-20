import { AgencyNode, FunctionCall, VariableType } from "../types.js";
import { AccessExpression } from "./access.js";
import { Literal } from "./literals.js";

/*
export type FunctionDefinition = {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  docString?: DocString;
};
*/

export type GraphNodeDefinition = {
  type: "graphNode";
  nodeName: string;
  parameters: string[];
  body: AgencyNode[];
  returnType?: VariableType | null;
};

export type NodeCall = {
  type: "nodeCall";
  nodeName: string;
  arguments: (Literal | AccessExpression | FunctionCall)[];
};
