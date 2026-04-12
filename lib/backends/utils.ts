import { FunctionCall, Literal, VariableType } from "../types.js";
import { ValueAccess } from "../types/access.js";
import { AgencyArray, AgencyObject } from "../types/dataStructures.js";
import { ReturnStatement } from "../types/returnStatement.js";

/** Check whether a type annotation represents Result or Result<S, E>. */
export function isResultType(type: VariableType): boolean {
  return type.type === "resultType";
}

export const wrapInReturn = (
  node: ValueAccess | FunctionCall | Literal | AgencyObject | AgencyArray
): ReturnStatement => {
  return {
    type: "returnStatement",
    value: node,
  };
};
