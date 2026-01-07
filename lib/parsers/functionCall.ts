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
import { accessExpressionParser } from "./access.js";
import { literalParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces, varNameChar } from "./utils.js";

const comma = seqR(optionalSpaces, char(","), optionalSpaces);
export const functionCallParser: Parser<FunctionCall> = (input: string) => {
  const parser = seqC(
    set("type", "functionCall"),
    capture(many1WithJoin(varNameChar), "functionName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        or(functionCallParser, accessExpressionParser, literalParser)
      ),
      "arguments"
    ),
    optionalSpaces,
    char(")"),
    optionalSemicolon
  );
  return parser(input);
};
