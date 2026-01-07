import { FunctionCall } from "../types.js";
import { Literal } from "./literals.js";
import { AgencyArray } from "./dataStructures.js";

export type DotProperty = {
  type: "dotProperty";
  object: Literal | FunctionCall | AccessExpression;
  propertyName: string;
};

export type IndexAccess = {
  type: "indexAccess";
  array: Literal | FunctionCall | AccessExpression | AgencyArray;
  index: Literal | FunctionCall | AccessExpression;
};

export type DotFunctionCall = {
  type: "dotFunctionCall";
  object: Literal | FunctionCall | AccessExpression;
  functionCall: FunctionCall;
};

export type AccessExpression = {
  type: "accessExpression";
  expression: DotProperty | IndexAccess | DotFunctionCall;
};
