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

import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "@/types/access";
import {
  seqC,
  set,
  capture,
  or,
  char,
  many1WithJoin,
  alphanum,
  ParserResult,
  Parser,
} from "tarsec";
import { functionCallParser } from "./functionCall";
import { literalParser } from "./literals";

export const dotPropertyParser = (input: string): ParserResult<DotProperty> => {
  const parser = seqC(
    set("type", "dotProperty"),
    capture(or(literalParser, functionCallParser), "object"),
    char("."),
    capture(many1WithJoin(alphanum), "propertyName")
  );

  return parser(input);
};

export const indexAccessParser = (input: string): ParserResult<IndexAccess> => {
  const parser = seqC(
    set("type", "indexAccess"),
    capture(or(literalParser, functionCallParser), "array"),
    char("["),
    capture(or(literalParser, functionCallParser), "index"),
    char("]")
  );

  return parser(input);
};

export const dotFunctionCallParser = (
  input: string
): ParserResult<DotFunctionCall> => {
  const parser = seqC(
    set("type", "dotFunctionCall"),
    capture(or(literalParser, functionCallParser), "object"),
    char("."),
    capture(functionCallParser, "functionCall")
  );

  return parser(input);
};

export const accessExpressionParser: Parser<AccessExpression> = seqC(
  set("type", "accessExpression"),
  capture(
    or(dotFunctionCallParser, dotPropertyParser, indexAccessParser),
    "expression"
  )
);
