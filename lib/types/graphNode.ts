import { AgencyNode, FunctionCall } from "@/types";
import { AccessExpression } from "./access";
import { Literal } from "./literals";

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
