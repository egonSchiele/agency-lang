import { FunctionCall } from "@/types";
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
import { accessExpressionParser } from "./access";
import { literalParser } from "./literals";
import { optionalSemicolon } from "./parserUtils";
import { optionalSpaces, varNameChar } from "./utils";

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
