import { EgonLog } from "egonlog";
import {
  anyChar,
  between,
  capture,
  eof,
  many,
  or,
  Parser,
  ParserResult,
  search,
  seqC,
  set,
  str,
  success,
  trace,
  setInputStr,
  TarsecError,
  failure,
  setTraceHost,
  setTraceId,
} from "tarsec";

import { accessExpressionParser } from "./parsers/access.js";
import { commentParser } from "./parsers/comment.js";
import {
  assignmentParser,
  functionParser,
  graphNodeParser,
  ifParser,
  messageThreadParser,
  timeBlockParser,
  whileLoopParser,
} from "./parsers/function.js";
import {
  functionCallParser,
  llmPromptFunctionCallParser,
  streamingPromptLiteralParser,
} from "./parsers/functionCall.js";
import {
  importNodeStatmentParser,
  importStatmentParser,
  importToolStatmentParser,
} from "./parsers/importStatement.js";
import { matchBlockParser } from "./parsers/matchBlock.js";
import { newLineParser } from "./parsers/newline.js";
import { returnStatementParser } from "./parsers/returnStatement.js";
import { specialVarParser } from "./parsers/specialVar.js";
import { usesToolParser } from "./parsers/tools.js";
import { typeAliasParser, typeHintParser } from "./parsers/typeHints.js";
import { AgencyNode, AgencyProgram } from "./types.js";
import { skillParser } from "./parsers/skill.js";
import { AgencyConfig } from "./config.js";
import { nanoid } from "nanoid";

export const agencyNode: Parser<AgencyNode[]> = (input: string) => {
  const parser = many(
    trace(
      "agencyParser",
      or(
        usesToolParser,
        importNodeStatmentParser,
        importToolStatmentParser,
        importStatmentParser,
        graphNodeParser,
        typeAliasParser,
        ifParser,
        whileLoopParser,
        typeHintParser,
        matchBlockParser,
        timeBlockParser,
        messageThreadParser,
        skillParser,
        streamingPromptLiteralParser,
        functionParser,
        returnStatementParser,
        specialVarParser,
        accessExpressionParser,
        assignmentParser,
        llmPromptFunctionCallParser,
        functionCallParser,
        commentParser,
        newLineParser,
      ),
    ),
  );

  return parser(input);
};

export const agencyParser: Parser<AgencyProgram> = seqC(
  set("type", "agencyProgram"),
  capture(agencyNode, "nodes"),
  eof,
);

export const _multilineCommentParser = between(str("/*"), str("*/"), anyChar);

export const multilineCommentParser = search(_multilineCommentParser);

export const normalizeCode = (code: string) => {
  const comments = multilineCommentParser(code);

  if (!comments.success) {
    throw new Error(comments.message);
  }

  return comments.rest
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
};

export function _parseAgency(
  input: string,
  config: AgencyConfig = {},
): ParserResult<AgencyProgram> {
  // get rid of all multiline comments
  const normalized = normalizeCode(input);
  if (normalized.trim().length === 0) {
    return success(
      {
        type: "agencyProgram",
        nodes: [],
      },
      "",
    );
  }
  setInputStr(normalized);
  if (config.tarsecTraceHost) {
    setTraceHost("http://localhost:1465");
    setTraceId(nanoid());
  }
  const result = agencyParser(normalized);
  return result;
}

export function parseAgency(
  input: string,
  config: AgencyConfig = {},
): ParserResult<AgencyProgram> {
  try {
    return _parseAgency(input, config);
  } catch (error) {
    if (error instanceof TarsecError) {
      console.log(error.data.prettyMessage);
      return failure(error.message, input);
    } else {
      throw error;
    }
  }
}
