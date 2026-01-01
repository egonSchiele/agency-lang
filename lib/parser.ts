import { typeAliasParser, typeHintParser } from "@/parsers/typeHints";
import { ADLNode, ADLProgram } from "@/types";
import {
  capture,
  eof,
  or,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  set,
  spaces,
  trace,
} from "tarsec";
import { accessExpressionParser } from "./parsers/access";
import { assignmentParser } from "./parsers/assignment";
import { functionParser } from "./parsers/function";
import { functionCallParser } from "./parsers/functionCall";
import { matchBlockParser } from "./parsers/matchBlock";

export const adlNode: Parser<ADLNode[]> = sepBy(
  spaces,
  trace(
    "adlParser",
    or(
      typeAliasParser,
      typeHintParser,
      matchBlockParser,
      functionParser,
      accessExpressionParser,
      assignmentParser,
      functionCallParser
    )
  )
);

export const adlParser: Parser<ADLProgram> = seqC(
  set("type", "adlProgram"),
  capture(adlNode, "nodes"),
  eof
);

export function parseADL(input: string): ParserResult<ADLProgram> {
  const normalized = input;
  /* .split("\n")
    .map((line, index) => {
      // remove trailing semicolons
      return line.replace(/;+\s*$/, "").trim();
    })
    .join("\n"); */
  const result = adlParser(normalized);
  return result;
}
