import { FunctionCall } from "@/types";
import {
  seqR,
  char,
  Parser,
  seqC,
  set,
  capture,
  many1WithJoin,
  alphanum,
  sepBy,
  or,
} from "tarsec";
import { literalParser } from "./literals";
import { optionalSpaces } from "./utils";
import { accessExpressionParser } from "./access";

const comma = seqR(optionalSpaces, char(","), optionalSpaces);
export const functionCallParser: Parser<FunctionCall> = (input: string) => {
  const parser = seqC(
    set("type", "functionCall"),
    capture(many1WithJoin(alphanum), "functionName"),
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
    char(")")
  );
  return parser(input);
};
