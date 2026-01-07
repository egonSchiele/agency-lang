import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "../types/access.js";
import {
  capture,
  char,
  many1WithJoin,
  or,
  Parser,
  ParserResult,
  seqC,
  set,
} from "tarsec";
import { agencyArrayParser } from "./dataStructures.js";
import { functionCallParser } from "./functionCall.js";
import { literalParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { varNameChar } from "./utils.js";

export const dotPropertyParser = (input: string): ParserResult<DotProperty> => {
  const parser = seqC(
    set("type", "dotProperty"),
    capture(or(literalParser, functionCallParser), "object"),
    char("."),
    capture(many1WithJoin(varNameChar), "propertyName")
  );

  return parser(input);
};

export const indexAccessParser = (input: string): ParserResult<IndexAccess> => {
  const parser = seqC(
    set("type", "indexAccess"),
    capture(or(agencyArrayParser, functionCallParser, literalParser), "array"),
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
