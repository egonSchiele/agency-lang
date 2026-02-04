import { FunctionCall } from "../types.js";
import {
  capture,
  char,
  many1WithJoin,
  or,
  Parser,
  sepBy,
  seqC,
  seqR,
  set,
} from "tarsec";
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { literalParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { comma, optionalSpaces, varNameChar } from "./utils.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";

export const functionCallParser: Parser<FunctionCall> = (input: string) => {
  const parser = seqC(
    set("type", "functionCall"),
    capture(many1WithJoin(varNameChar), "functionName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        or(
          agencyArrayParser,
          agencyObjectParser,
          indexAccessParser,
          functionCallParser,
          accessExpressionParser,
          literalParser,
        ),
      ),
      "arguments",
    ),
    optionalSpaces,
    char(")"),
    optionalSemicolon,
  );
  return parser(input);
};
