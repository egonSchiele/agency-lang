import { AgencyNode, FunctionCall } from "../types.js";
import { AccessExpression } from "./access.js";
import { Literal } from "./literals.js";

export type GraphNodeDefinition = {
  type: "graphNode";
  nodeName: string;
  parameters: string[];
  body: AgencyNode[];
};

export type NodeCall = {
  type: "nodeCall";
  nodeName: string;
  arguments: (Literal | AccessExpression | FunctionCall)[];
};
