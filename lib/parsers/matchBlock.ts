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
  captureCaptures,
  char,
  many,
  many1,
  newline,
  or,
  parseError,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  set,
  str,
} from "tarsec";
import { DefaultCase, MatchBlockCase } from "../types/matchBlock.js";
import { commentParser } from "./comment.js";
import { exprParser } from "./expression.js";
import { assignmentParser } from "./function.js";
import { optionalSemicolon } from "./parserUtils.js";
import { returnStatementParser } from "./returnStatement.js";
import { optionalSpaces, optionalSpacesOrNewline } from "./utils.js";

export const defaultCaseParser: Parser<DefaultCase> = char("_");

export const matchBlockParserCase: Parser<MatchBlockCase> = (
  input: string,
): ParserResult<MatchBlockCase> => {
  const parser = seqC(
    set("type", "matchBlockCase"),
    optionalSpaces,
    capture(or(defaultCaseParser, exprParser), "caseValue"),
    optionalSpaces,
    str("=>"),
    optionalSpaces,
    capture(or(returnStatementParser, assignmentParser, exprParser), "body"),
    optionalSemicolon,
    optionalSpacesOrNewline,
  );
  return parser(input);
};

const semicolon = seqC(optionalSpaces, char(";"), optionalSpaces);

export const matchBlockParser = seqC(
  set("type", "matchBlock"),
  str("match"),
  optionalSpaces,
  char("("),
  capture(exprParser, "expression"),
  char(")"),
  optionalSpaces,
  char("{"),
  captureCaptures(
    parseError(
      "expected match cases of the form `value => expression` separated by `;` or newlines, followed by `}`",
      optionalSpacesOrNewline,
      capture(many(or(commentParser, matchBlockParserCase)), "cases"),
      optionalSpaces,
      char("}"),
    ),
  ),
  optionalSemicolon,
);
