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

import {
  capture,
  char,
  newline,
  optional,
  or,
  Parser,
  sepBy,
  seqC,
  set,
  str,
  trace,
} from "tarsec";
import { optionalSpaces } from "./utils";
import { literalParser } from "./literals";
import { assignmentParser } from "./assignment";
import { functionCallParser } from "./functionCall";
import { DefaultCase, MatchBlockCase } from "@/types/matchBlock";
import { accessExpressionParser } from "./access";
import { optionalSemicolon } from "./parserUtils";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures";
import * as parsers from "../parser";
import { commentParser } from "./comment";
import { returnStatementParser } from "./returnStatement";

export const defaultCaseParser: Parser<DefaultCase> = char("_");

export const matchBlockParserCase: Parser<MatchBlockCase> = seqC(
  set("type", "matchBlockCase"),
  optionalSpaces,
  capture(
    or(defaultCaseParser, accessExpressionParser, literalParser),
    "caseValue"
  ),
  optionalSpaces,
  str("=>"),
  optionalSpaces,
  capture(
    or(
      returnStatementParser,
      agencyArrayParser,
      agencyObjectParser,
      accessExpressionParser,
      assignmentParser,
      functionCallParser,
      literalParser
    ),
    "body"
  )
);

const semicolon = seqC(optionalSpaces, char(";"), optionalSpaces);

export const matchBlockParser = seqC(
  set("type", "matchBlock"),
  str("match"),
  optionalSpaces,
  char("("),
  capture(literalParser, "expression"),
  char(")"),
  optionalSpaces,
  char("{"),
  optionalSpaces,
  capture(
    sepBy(or(semicolon, newline), or(commentParser, matchBlockParserCase)),
    "cases"
  ),
  optionalSpaces,
  char("}"),
  optionalSemicolon
);
