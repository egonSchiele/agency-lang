import { FunctionCall, Literal } from "../types.js";
import { ValueAccess } from "../types/access.js";
import { AgencyArray, AgencyObject } from "../types/dataStructures.js";
import { ReturnStatement } from "../types/returnStatement.js";

export const wrapInReturn = (
  node: ValueAccess | FunctionCall | Literal | AgencyObject | AgencyArray
): ReturnStatement => {
  return {
    type: "returnStatement",
    value: node,
  };
};
