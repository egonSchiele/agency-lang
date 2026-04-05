import { FunctionCall, NamedArgument } from "../types.js";
import {
  capture,
  char,
  label,
  lazy,
  many1WithJoin,
  or,
  Parser,
  sepBy,
  seqC,
  set,
  trace,
} from "tarsec";
import { splatParser } from "./dataStructures.js";
import { exprParser } from "./expression.js";
import { optionalSemicolon } from "./parserUtils.js";
import { comma, optionalSpaces, optionalSpacesOrNewline, varNameChar } from "./utils.js";

const namedArgumentParser: Parser<NamedArgument> = trace(
  "namedArgumentParser",
  seqC(
    set("type", "namedArgument"),
    capture(many1WithJoin(varNameChar), "name"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(lazy(() => exprParser), "value"),
  ),
);

export const _functionCallParser: Parser<FunctionCall> = (input: string) => {
  const parser = seqC(
    set("type", "functionCall"),
    capture(many1WithJoin(varNameChar), "functionName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        or(
          namedArgumentParser,
          splatParser,
          lazy(() => exprParser),
        ),
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
export const functionCallParser: Parser<FunctionCall> = label("a function call", _functionCallParser);
