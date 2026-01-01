import { typeAliasParser, typeHintParser } from "@/parsers/typeHints";
import { ADLNode, ADLProgram, AwaitStatement } from "@/types";
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
  str,
  trace,
} from "tarsec";
import { assignmentParser } from "./parsers/assignment";
import { functionParser } from "./parsers/function";
import { functionCallParser } from "./parsers/functionCall";
import { matchBlockParser } from "./parsers/matchBlock";
import { accessExpressionParser } from "./parsers/access";
import { literalParser } from "./parsers/literals";

export const awaitStatementParser: Parser<AwaitStatement> = seqC(
  set("type", "awaitStatement"),
  capture(
    or(accessExpressionParser, functionCallParser, literalParser),
    "value"
  )
);

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
  const result = adlParser(input);
  return result;
}
