import { typeAliasParser, typeHintParser } from "@/parsers/typeHints";
import { AgencyNode, AgencyProgram } from "@/types";
import { exit } from "process";
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
import { accessExpressionParser } from "./parsers/access";
import { assignmentParser } from "./parsers/assignment";
import { commentParser } from "./parsers/comment";
import { functionParser, graphNodeParser } from "./parsers/function";
import { functionCallParser } from "./parsers/functionCall";
import { importStatmentParser } from "./parsers/importStatement";
import { matchBlockParser } from "./parsers/matchBlock";
import { returnStatementParser } from "./parsers/returnStatement";
import { usesToolParser } from "./parsers/tools";

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
  console.log(normalized);
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
