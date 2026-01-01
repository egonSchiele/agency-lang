import { Assignment } from "@/types";
import {
  alphanum,
  capture,
  char,
  many1Till,
  many1WithJoin,
  or,
  Parser,
  seqC,
  set,
  space,
  trace,
} from "tarsec";
import { literalParser } from "./literals";
import { optionalSpaces } from "./utils";
import { functionCallParser } from "./functionCall";
import { accessExpressionParser } from "./access";
import { optionalSemicolon } from "./parserUtils";

export const assignmentParser: Parser<Assignment> = trace(
  "assignmentParser",
  seqC(
    set("type", "assignment"),
    optionalSpaces,
    capture(many1WithJoin(alphanum), "variableName"),
    optionalSpaces,
    char("="),
    optionalSpaces,
    capture(
      or(functionCallParser, accessExpressionParser, literalParser),
      "value"
    ),
    optionalSemicolon
  )
);
