/*
import { FunctionCall } from "@/types";
import { Literal } from "./literals";

export type DotProperty = {
  type: "dotProperty";
  object: Literal | FunctionCall;
  propertyName: string;
};

export type IndexAccess = {
  type: "indexAccess";
  array: Literal | FunctionCall;
  index: Literal | FunctionCall;
};

export type DotFunctionCall = {
  type: "dotFunctionCall";
  object: Literal | FunctionCall;
  functionCall: FunctionCall;
};

export type AccessExpression = {
  type: "accessExpression";
  expression: DotProperty | IndexAccess | DotFunctionCall;
}
  */

export const dotPropertyParser = seqC(
  set("type", "dotProperty"),
  capture(or(literalParser, functionCallParser), "object"),
  char("."),
  capture(many1WithJoin(alphanum), "propertyName")
);