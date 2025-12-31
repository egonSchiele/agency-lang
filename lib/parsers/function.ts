import { FunctionDefinition, FunctionCall } from "@/types";
import {
  trace,
  sepBy,
  spaces,
  or,
  Parser,
  seqC,
  set,
  str,
  many1,
  space,
  capture,
  many1Till,
  char,
  many1WithJoin,
  alphanum,
  seqR,
} from "tarsec";
import { literalParser } from "./literals";
import { optionalSpaces } from "./utils";
import { assignmentParser } from "./assignment";

export const functionBodyParser = trace(
  "functionBodyParser",
  sepBy(spaces, or(assignmentParser, literalParser))
);

export const functionParser: Parser<FunctionDefinition> = trace(
  "functionParser",
  seqC(
    set("type", "function"),
    str("def"),
    many1(space),
    capture(many1Till(char("(")), "functionName"),
    char("("),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    char("{"),
    capture(functionBodyParser, "body"),
    optionalSpaces,
    char("}")
  )
);

const comma = seqR(optionalSpaces, char(","), optionalSpaces);
export const functionCallParser: Parser<FunctionCall> = seqC(
  set("type", "functionCall"),
  capture(many1WithJoin(alphanum), "functionName"),
  char("("),
  optionalSpaces,
  capture(
    sepBy(
      comma,
      literalParser
    ),
    "arguments"
  ),
  optionalSpaces,
  char(")")
);
