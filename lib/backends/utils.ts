import node from "@/templates/backends/graphGenerator/node";
import { AccessExpression, ADLNode, FunctionCall, Literal } from "@/types";
import { ADLObject, ADLArray } from "@/types/dataStructures";
import { ReturnStatement } from "@/types/returnStatement";

export const wrapInReturn = (
  node: AccessExpression | FunctionCall | Literal | ADLObject | ADLArray
): ReturnStatement => {
  return {
    type: "returnStatement",
    value: node,
  };
};
