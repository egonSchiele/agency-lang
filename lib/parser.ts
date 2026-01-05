import { typeAliasParser, typeHintParser } from "@/parsers/typeHints";
import { AgencyNode, AgencyProgram, AgencyComment } from "@/types";
import {
  capture,
  eof,
  many1Till,
  newline,
  or,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  set,
  spaces,
  str,
  trace,
} from "tarsec";
import { accessExpressionParser } from "./parsers/access";
import { assignmentParser } from "./parsers/assignment";
import { functionParser, graphNodeParser } from "./parsers/function";
import { functionCallParser } from "./parsers/functionCall";
import { matchBlockParser } from "./parsers/matchBlock";
import { commentParser } from "./parsers/comment";
import { ReturnStatement } from "@/types/returnStatement";
import { optionalSpaces } from "./parsers/utils";
import { optionalSemicolon } from "./parsers/parserUtils";
import { returnStatementParser } from "./parsers/returnStatement";
import { usesToolParser } from "./parsers/tools";
import { importStatmentParser } from "./parsers/importStatement";

export const agencyNode: Parser<AgencyNode[]> = (input: string) => {
  const parser = sepBy(
    spaces,
    trace(
      "agencyParser",
      or(
        usesToolParser,
        importStatmentParser,
        typeAliasParser,
        typeHintParser,
        matchBlockParser,
        graphNodeParser,
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

export function parseAgency(input: string): ParserResult<AgencyProgram> {
  const normalized = input
    .split("\n")
    .map((line: string) => {
      return line.trim();
    })
    .join("\n");
  const result = agencyParser(normalized);
  return result;
}
