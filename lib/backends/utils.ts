import node from "../templates/backends/graphGenerator/node.js";
import { AccessExpression, AgencyNode, FunctionCall, Literal } from "../types.js";
import { AgencyObject, AgencyArray } from "../types/dataStructures.js";
import { ReturnStatement } from "../types/returnStatement.js";

export const wrapInReturn = (
  node: AccessExpression | FunctionCall | Literal | AgencyObject | AgencyArray
): ReturnStatement => {
  return {
    type: "returnStatement",
    value: node,
  };
};
