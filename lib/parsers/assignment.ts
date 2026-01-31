import { Assignment } from "../types.js";
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
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { functionCallParser } from "./functionCall.js";
import { literalParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces, varNameChar } from "./utils.js";
import { timeBlockParser } from "./function.js";

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
        timeBlockParser,
        functionCallParser,
        indexAccessParser,
        accessExpressionParser,
        agencyArrayParser,
        agencyObjectParser,
        literalParser,
      ),
      "value",
    ),
    optionalSemicolon,
  ),
);
