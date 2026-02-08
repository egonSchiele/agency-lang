import { typeAliasParser, typeHintParser } from "./parsers/typeHints.js";
import { AgencyNode, AgencyProgram, NewLine } from "./types.js";
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
  sepBy,
  seqC,
  set,
  spaces,
  str,
  success,
  trace,
} from "tarsec";
import { accessExpressionParser } from "./parsers/access.js";
import { commentParser } from "./parsers/comment.js";
import {
  assignmentParser,
  functionParser,
  graphNodeParser,
  ifParser,
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
import { returnStatementParser } from "./parsers/returnStatement.js";
import { usesToolParser } from "./parsers/tools.js";
import { EgonLog } from "egonlog";
import { specialVarParser } from "./parsers/specialVar.js";
import { awaitParser } from "./parsers/await.js";
import { newLineParser } from "./parsers/newline.js";

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
        awaitParser,
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

export function parseAgency(
  input: string,
  verbose: boolean = false,
): ParserResult<AgencyProgram> {
  const logger = new EgonLog({ level: verbose ? "debug" : "warn" });

  let normalized = input;
  logger.debug("Starting to parse agency program");
  logger.debug(`Input: ${input}`);
  logger.debug("================================");
  const comments = multilineCommentParser(normalized);
  logger.debug(`Multiline comments: ${JSON.stringify(comments)}`);
  logger.debug("================================");

  // get rid of all multiline comments
  normalized = comments.rest
    .split("\n")
    .map((line: string) => {
      return line.trim();
    })
    .join("\n");
  if (normalized.trim().length === 0) {
    return success(
      {
        type: "agencyProgram",
        nodes: [],
      },
      "",
    );
  }

  logger.debug(`Normalized input: ${normalized}`);
  logger.debug("================================");

  const result = agencyParser(normalized);
  return result;
}
