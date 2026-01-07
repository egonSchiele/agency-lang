import { typeAliasParser, typeHintParser } from "./parsers/typeHints.js";
import { AgencyNode, AgencyProgram } from "./types.js";
import {
  anyChar,
  between,
  capture,
  eof,
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
import { assignmentParser } from "./parsers/assignment.js";
import { commentParser } from "./parsers/comment.js";
import {
  functionParser,
  graphNodeParser,
  whileLoopParser,
} from "./parsers/function.js";
import { functionCallParser } from "./parsers/functionCall.js";
import { importStatmentParser } from "./parsers/importStatement.js";
import { matchBlockParser } from "./parsers/matchBlock.js";
import { returnStatementParser } from "./parsers/returnStatement.js";
import { usesToolParser } from "./parsers/tools.js";

export const agencyNode: Parser<AgencyNode[]> = (input: string) => {
  const parser = sepBy(
    spaces,
    trace(
      "agencyParser",
      or(
        usesToolParser,
        importStatmentParser,
        graphNodeParser,
        typeAliasParser,
        whileLoopParser,
        typeHintParser,
        matchBlockParser,
        functionParser,
        returnStatementParser,
        accessExpressionParser,
        assignmentParser,
        functionCallParser,
        commentParser
      )
    )
  );

  return parser(input);
};

export const agencyParser: Parser<AgencyProgram> = seqC(
  set("type", "agencyProgram"),
  capture(agencyNode, "nodes"),
  eof
);

export const _multilineCommentParser = between(str("/*"), str("*/"), anyChar);

export const multilineCommentParser = search(_multilineCommentParser);

export function parseAgency(input: string): ParserResult<AgencyProgram> {
  let normalized = input;

  const comments = multilineCommentParser(normalized);

  // get rid of all multiline comments
  normalized = comments.rest
    .split("\n")
    .map((line: string) => {
      return line.trim();
    })
    .filter((l) => l.length > 0)
    .join("\n");
  if (normalized.trim().length === 0) {
    return success(
      {
        type: "agencyProgram",
        nodes: [],
      },
      ""
    );
  }
  const result = agencyParser(normalized);
  return result;
}
