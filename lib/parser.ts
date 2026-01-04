import { typeAliasParser, typeHintParser } from "@/parsers/typeHints";
import { ADLNode, ADLProgram, ADLComment } from "@/types";
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

export const adlNode: Parser<ADLNode[]> = (input: string) => {
  const parser = sepBy(
    spaces,
    trace(
      "adlParser",
      or(
        usesToolParser,
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

export const adlParser: Parser<ADLProgram> = seqC(
  set("type", "adlProgram"),
  capture(adlNode, "nodes"),
  eof
);

export function parseADL(input: string): ParserResult<ADLProgram> {
  const normalized = input
    .split("\n")
    .map((line: string) => {
      return line.trim();
    })
    .join("\n");
  const result = adlParser(normalized);
  return result;
}
