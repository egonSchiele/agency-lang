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
  or,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  set,
  str,
} from "tarsec";
import { DefaultCase, MatchBlockCase } from "../types/matchBlock.js";
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { commentParser } from "./comment.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { assignmentParser } from "./function.js";
import {
  functionCallParser,
  llmPromptFunctionCallParser,
  streamingPromptLiteralParser,
} from "./functionCall.js";
import { literalParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { returnStatementParser } from "./returnStatement.js";
import { optionalSpaces, optionalSpacesOrNewline } from "./utils.js";
import { binOpParser } from "./binop.js";

export const defaultCaseParser: Parser<DefaultCase> = char("_");

export const matchBlockParserCase: Parser<MatchBlockCase> = (
  input: string,
): ParserResult<MatchBlockCase> => {
  const parser = seqC(
    set("type", "matchBlockCase"),
    optionalSpaces,
    capture(
      or(
        defaultCaseParser,
        indexAccessParser,
        accessExpressionParser,
        literalParser,
      ),
      "caseValue",
    ),
    optionalSpaces,
    str("=>"),
    optionalSpaces,
    capture(
      or(
        returnStatementParser,
        streamingPromptLiteralParser,
        llmPromptFunctionCallParser,
        agencyArrayParser,
        agencyObjectParser,
        accessExpressionParser,
        assignmentParser,
        functionCallParser,
        literalParser,
      ),
      "body",
    ),
  );
  return parser(input);
};

const semicolon = seqC(optionalSpaces, char(";"), optionalSpaces);

export const matchBlockParser = seqC(
  set("type", "matchBlock"),
  str("match"),
  optionalSpaces,
  char("("),
  capture(or(binOpParser, literalParser), "expression"),
  char(")"),
  optionalSpaces,
  char("{"),
  optionalSpacesOrNewline,
  capture(
    sepBy(or(semicolon, newline), or(commentParser, matchBlockParserCase)),
    "cases",
  ),
  optionalSpaces,
  char("}"),
  optionalSemicolon,
);
