import { FunctionCall } from "../types.js";
import {
  capture,
  char,
  lazy,
  many1WithJoin,
  Parser,
  sepBy,
  seqC,
  set,
} from "tarsec";
import { exprParser } from "./expression.js";
import { optionalSemicolon } from "./parserUtils.js";
import { comma, optionalSpaces, optionalSpacesOrNewline, varNameChar } from "./utils.js";

export const _functionCallParser: Parser<FunctionCall> = (input: string) => {
  const parser = seqC(
    set("type", "functionCall"),
    capture(many1WithJoin(varNameChar), "functionName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        lazy(() => exprParser),
      ),
      "arguments",
    ),
    optionalSpaces,
    char(")"),
    optionalSemicolon,
    optionalSpacesOrNewline
  );
  return parser(input);
};

// functionCallParser is now just _functionCallParser (no async/sync wrappers - handled by valueAccessParser)
export const functionCallParser: Parser<FunctionCall> = _functionCallParser;
