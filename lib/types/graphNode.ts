import { AgencyNode, FunctionCall, VariableType } from "../types.js";
import { AccessExpression } from "./access.js";
import { FunctionParameter } from "./function.js";
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

export type Visibility = "public" | "private" | undefined;

export type GraphNodeDefinition = {
  type: "graphNode";
  nodeName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  visibility?: Visibility;

  // what message threads exist in this node?
  // we need to initialize them.
  threadIds?: string[];
};

export type NodeCall = {
  type: "nodeCall";
  nodeName: string;
  arguments: (Literal | AccessExpression | FunctionCall)[];
};
