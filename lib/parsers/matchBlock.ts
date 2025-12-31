/*
export type MatchBlock = {
  type: "matchBlock";
  expression: Literal;
  cases: Array<{
    caseValue: Literal;
    body: Assignment | Literal | FunctionCall;
  }>;
};
*/

import { capture, char, newline, optional, or, Parser, sepBy, seqC, set, str, trace } from "tarsec";
import { optionalSpaces } from "./utils";
import { literalParser } from "./literals";
import { assignmentParser } from "./assignment";
import { functionCallParser } from "./functionCall";
import { DefaultCase, MatchBlockCase } from "@/types/matchBlock";

export const defaultCaseParser: Parser<DefaultCase> = char("_")

export const matchBlockParserCase: Parser<MatchBlockCase> = seqC(
  optionalSpaces,
  capture(or(literalParser, defaultCaseParser), "caseValue"),
  optionalSpaces,
  str("=>"),
  optionalSpaces,
  capture(or(assignmentParser, functionCallParser, literalParser), "body"),
)

const semicolon = seqC(optionalSpaces, char(";"), optionalSpaces);

export const matchBlockParser = trace("matchBlockParser", seqC(
  set("type", "matchBlock"),
  str("match"),
  char("("),
  capture(literalParser, "expression"),
  char(")"),
  optionalSpaces,
  char("{"),
  optionalSpaces,
  capture(sepBy(or(semicolon, newline), matchBlockParserCase), "cases"),
  optionalSpaces,
  char("}"),

))