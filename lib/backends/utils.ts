import { AccessExpression, FunctionCall, Literal } from "../types.js";
import { AgencyArray, AgencyObject } from "../types/dataStructures.js";
import { ReturnStatement } from "../types/returnStatement.js";

export const wrapInReturn = (
  node: AccessExpression | FunctionCall | Literal | AgencyObject | AgencyArray
): ReturnStatement => {
  return {
    type: "returnStatement",
    value: node,
  };
};
