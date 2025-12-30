import {
  alphanum,
  capture,
  char,
  digit,
  eof,
  many,
  many1,
  many1Till,
  many1WithJoin,
  manyTill,
  map,
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
import {
  ADLNode,
  ADLProgram,
  ArrayType,
  Assignment,
  FunctionCall,
  FunctionDefinition,
  InterpolationSegment,
  Literal,
  NumberLiteral,
  PrimitiveType,
  PromptLiteral,
  StringLiteral,
  TextSegment,
  TypeHint,
  VariableNameLiteral,
  VariableType,
} from "./types";

const optionalSpaces = many(space);

const backtick = char("`");

export const textSegmentParser: Parser<TextSegment> = map(
  many1Till(or(backtick, char("$"))),
  (text) => ({
    type: "text",
    value: text,
  })
);

export const interpolationSegmentParser: Parser<InterpolationSegment> = seqC(
  set("type", "interpolation"),
  char("$"),
  char("{"),
  capture(many1Till(char("}")), "variableName"),
  char("}")
);

export const promptParser: Parser<PromptLiteral> = seqC(
  set("type", "prompt"),
  backtick,
  capture(many(or(textSegmentParser, interpolationSegmentParser)), "segments"),
  backtick
);
export const numberParser: Parser<NumberLiteral> = seqC(
  set("type", "number"),
  capture(many1WithJoin(or(char("-"), char("."), digit)), "value")
);
export const stringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  char('"'),
  capture(manyTill(char('"')), "value"),
  char('"')
);
export const variableNameParser: Parser<VariableNameLiteral> = trace(
  "variableNameParser",
  seqC(set("type", "variableName"), capture(many1WithJoin(alphanum), "value"))
);

export const literalParser: Parser<Literal> = or(
  promptParser,
  numberParser,
  stringParser,
  variableNameParser
);
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

export const primitiveTypeParser: Parser<PrimitiveType> = seqC(
  set("type", "primitiveType"),
  capture(or(str("number"), str("string"), str("boolean")), "value")
);

export const arrayTypeParser: Parser<ArrayType> = seqC(
  set("type", "arrayType"),
  capture(primitiveTypeParser, "elementType"),
  str("[]")
);

export const angleBracketsArrayTypeParser: Parser<ArrayType> = seqC(
  set("type", "arrayType"),
  str("array"),
  char("<"),
  capture(primitiveTypeParser, "elementType"),
  char(">")
);

export const variableTypeParser: Parser<VariableType> = or(
  angleBracketsArrayTypeParser,
  arrayTypeParser,
  primitiveTypeParser
);

export const typeHintParser: Parser<TypeHint> = seqC(
  set("type", "typeHint"),
  capture(many1Till(space), "variableName"),
  optionalSpaces,
  str("::"),
  optionalSpaces,
  capture(variableTypeParser, "variableType")
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
