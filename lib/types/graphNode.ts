import { AgencyNode, FunctionCall, VariableType } from "../types.js";
import { ValueAccess } from "./access.js";
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
};

export type NodeCall = {
  type: "nodeCall";
  nodeName: string;
  arguments: (Literal | ValueAccess | FunctionCall)[];
};
