import { AgencyNode, FunctionCall } from "../types.js";
import { Literal } from "./literals.js";

export type DotProperty = {
  type: "dotProperty";
  object: AgencyNode;
  propertyName: string;
};

export type IndexAccess = {
  type: "indexAccess";
  array: AgencyNode;
  index: Literal | FunctionCall | AccessExpression;
};

export type DotFunctionCall = {
  type: "dotFunctionCall";
  object: AgencyNode;
  functionCall: FunctionCall;
};

export type AccessExpression = {
  type: "accessExpression";
  expression: DotProperty | IndexAccess | DotFunctionCall;
};

export function accessExpression(expression: DotProperty | IndexAccess | DotFunctionCall): AccessExpression {
  return {
    type: "accessExpression" as const,
    expression
  }
}