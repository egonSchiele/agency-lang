import { optionalSpaces } from "@/parsers/utils";
import {
  ArrayType,
  BooleanLiteralType,
  NumberLiteralType,
  PrimitiveType,
  StringLiteralType,
  TypeHint,
  UnionType,
  VariableType,
} from "@/types";
import {
  capture,
  char,
  digit,
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
  str
} from "tarsec";

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

export const stringLiteralTypeParser: Parser<StringLiteralType> = seqC(
  set("type", "stringLiteralType"),
  char('"'),
  capture(many1Till(char('"')), "value"),
  char('"')
);

export const numberLiteralTypeParser: Parser<NumberLiteralType> = seqC(
  set("type", "numberLiteralType"),
  capture(many1WithJoin(or(char("-"), char("."), digit)), "value")
);

export const booleanLiteralTypeParser: Parser<BooleanLiteralType> = seqC(
  set("type", "booleanLiteralType"),
  capture(or(str("true"), str("false")), "value")
);

const pipe = seqR(optionalSpaces, str("|"), optionalSpaces);

export const unionTypeParser: Parser<UnionType> = (input: string): ParserResult<UnionType> => {
  const parser = seqC(
    set("type", "unionType"),
    capture(sepBy(pipe, variableTypeParser), "types")
  );
  return parser(input);
}

export const variableTypeParser: Parser<VariableType> = or(
  angleBracketsArrayTypeParser,
  arrayTypeParser,
  stringLiteralTypeParser,
  numberLiteralTypeParser,
  booleanLiteralTypeParser,
  primitiveTypeParser
);

export const typeHintParser: Parser<TypeHint> = seqC(
  set("type", "typeHint"),
  capture(many1Till(space), "variableName"),
  optionalSpaces,
  str("::"),
  optionalSpaces,
  capture(or(unionTypeParser, variableTypeParser), "variableType")
);

