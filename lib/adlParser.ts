import {
  alphanum,
  anyChar,
  capture,
  captureCaptures,
  char,
  digit,
  many,
  many1,
  many1Till,
  many1WithJoin,
  manyTill,
  or,
  Parser,
  sepBy,
  seqC,
  seqR,
  set,
  space,
  spaces,
  str,
  trace,
} from "tarsec";
import { ADLNode, ADLProgram, Assignment, FunctionDefinition, Literal, NumberLiteral, PromptLiteral, StringLiteral, TypeHint, VariableNameLiteral } from "./types";


const optionalSpaces = many(space);


const backtick = char("`");
export const promptParser: Parser<PromptLiteral> = seqC(set("type", "prompt"), backtick, capture(manyTill(backtick), "text"), backtick);
export const numberParser: Parser<NumberLiteral> = seqC(set("type", "number"), capture(many1WithJoin(or(char("-"), char("."), digit)), "value"));
export const stringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  char('"'),
  capture(manyTill(char('"')), "value"),
  char('"')
);
export const variableNameParser: Parser<VariableNameLiteral> = trace("variableNameParser",
  seqC(set("type", "variableName"),
    capture(many1WithJoin(alphanum), "value")
  ));

export const literalParser: Parser<Literal> = or(promptParser, numberParser, stringParser, variableNameParser);
export const assignmentParser: Parser<Assignment> = trace("assignmentParser", seqC(
  set("type", "assignment"),
  optionalSpaces,
  capture(many1Till(or(space, char("="))), "variableName"),
  optionalSpaces,
  char("="),
  optionalSpaces,
  capture(literalParser, "value")
));

export const functionBodyParser = trace("functionBodyParser",
  sepBy(spaces, or(assignmentParser, literalParser))
);

export const functionParser: Parser<FunctionDefinition> = trace("functionParser", seqC(
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
));

export const typeHintParser: Parser<TypeHint> = trace("typeHintParser", seqC(
  set("type", "typeHint"),
  capture(many1Till(space), "variableName"),
  optionalSpaces,
  str("::"),
  optionalSpaces,
  capture(many1Till(space), "variableType")
));

export const adlNode: Parser<ADLNode[]> = sepBy(spaces, trace("adlParser", or(typeHintParser, functionParser, assignmentParser)));

export const adlParser: Parser<ADLProgram> = seqC(
  set("type", "adlProgram"),
  capture(adlNode, "nodes")
);
