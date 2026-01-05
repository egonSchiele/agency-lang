import node from "@/templates/backends/graphGenerator/node";
import { AccessExpression, AgencyNode, FunctionCall, Literal } from "@/types";
import { AgencyObject, AgencyArray } from "@/types/dataStructures";
import { ReturnStatement } from "@/types/returnStatement";

export const wrapInReturn = (
  node: AccessExpression | FunctionCall | Literal | AgencyObject | AgencyArray
): ReturnStatement => {
  return {
    type: "returnStatement",
    value: node,
  };
};
