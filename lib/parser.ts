import {
  alphanum,
  capture,
  char,
  eof,
  many,
  many1,
  many1Till,
  many1WithJoin,
  or,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  seqR,
  set,
  space,
  spaces,
  str,
  trace,
} from "tarsec";
import { literalParser } from "@/parsers/literals";
import { typeHintParser } from "@/parsers/typeHints";
import {
  ADLNode,
  ADLProgram,
  Assignment,
  FunctionCall,
  FunctionDefinition,
} from "@/types";

const optionalSpaces = many(space);

export const assignmentParser: Parser<Assignment> = trace(
  "assignmentParser",
  seqC(
    set("type", "assignment"),
    optionalSpaces,
    capture(many1Till(or(space, char("="))), "variableName"),
    optionalSpaces,
    char("="),
    optionalSpaces,
    capture(literalParser, "value")
  )
);

export const functionBodyParser = trace(
  "functionBodyParser",
  sepBy(spaces, or(assignmentParser, literalParser))
);

export const functionParser: Parser<FunctionDefinition> = trace(
  "functionParser",
  seqC(
    set("type", "function"),
    str("def"),
    many1(space),
    capture(many1Till(char("(")), "functionName"),
    char("("),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    char("{"),
    capture(functionBodyParser, "body"),
    optionalSpaces,
    char("}")
  )
);

export const functionCallParser: Parser<FunctionCall> = seqC(
  set("type", "functionCall"),
  capture(many1WithJoin(alphanum), "functionName"),
  char("("),
  optionalSpaces,
  capture(
    sepBy(
      seqR(optionalSpaces, char(","), optionalSpaces),
      many1WithJoin(alphanum)
    ),
    "arguments"
  ),
  optionalSpaces,
  char(")")
);

export const adlNode: Parser<ADLNode[]> = sepBy(
  spaces,
  trace(
    "adlParser",
    or(typeHintParser, functionParser, assignmentParser, functionCallParser)
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
