import { FunctionCall } from "../types.js";
import {
  capture,
  char,
  many1WithJoin,
  or,
  Parser,
  sepBy,
  seqC,
  set,
} from "tarsec";
import { valueAccessParser } from "./access.js";
import {
  booleanParser,
  literalParser,
  literalParserNoVarName,
  variableNameParser,
} from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { comma, optionalSpaces, varNameChar } from "./utils.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { binOpParser } from "./binop.js";

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
          agencyArrayParser,
          agencyObjectParser,
          booleanParser,
          literalParserNoVarName,
          binOpParser,
          valueAccessParser,
          variableNameParser,
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

// functionCallParser is now just _functionCallParser (no async/sync wrappers - handled by valueAccessParser)
export const functionCallParser: Parser<FunctionCall> = _functionCallParser;
