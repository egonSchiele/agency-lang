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
import { optionalSemicolon } from "./parserUtils";
import { adlArrayParser } from "./dataStructures";

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
    capture(or(adlArrayParser, functionCallParser, literalParser), "array"),
    char("["),
    capture(or(functionCallParser, literalParser), "index"),
    char("]")
  );

  return parser(input);
};

export const dotFunctionCallParser = (
  input: string
): ParserResult<DotFunctionCall> => {
  const parser = seqC(
    set("type", "dotFunctionCall"),
    capture(or(functionCallParser, literalParser), "object"),
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
  ),
  optionalSemicolon
);
