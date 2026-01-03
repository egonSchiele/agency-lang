import { Assignment } from "@/types";
import {
  capture,
  char,
  many1WithJoin,
  or,
  Parser,
  seqC,
  set,
  trace,
} from "tarsec";
import { accessExpressionParser } from "./access";
import { adlArrayParser, adlObjectParser } from "./dataStructures";
import { functionCallParser } from "./functionCall";
import { literalParser } from "./literals";
import { optionalSemicolon } from "./parserUtils";
import { optionalSpaces, varNameChar } from "./utils";

export const assignmentParser: Parser<Assignment> = trace(
  "assignmentParser",
  seqC(
    set("type", "assignment"),
    optionalSpaces,
    capture(many1WithJoin(varNameChar), "variableName"),
    optionalSpaces,
    char("="),
    optionalSpaces,
    capture(
      or(
        functionCallParser,
        accessExpressionParser,
        adlArrayParser,
        adlObjectParser,
        literalParser
      ),
      "value"
    ),
    optionalSemicolon
  )
);
