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
import { optionalSpaces } from "./utils.js";
import { literalParser } from "./literals.js";
import { assignmentParser } from "./assignment.js";
import { functionCallParser } from "./functionCall.js";
import { DefaultCase, MatchBlockCase } from "../types/matchBlock.js";
import { accessExpressionParser } from "./access.js";
import { optionalSemicolon } from "./parserUtils.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import * as parsers from "../parser.js";
import { commentParser } from "./comment.js";
import { returnStatementParser } from "./returnStatement.js";

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
