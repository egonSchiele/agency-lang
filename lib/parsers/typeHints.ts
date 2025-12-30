import {
  Parser,
  seqC,
  set,
  capture,
  or,
  str,
  char,
  many1Till,
  space,
  digit,
  many1,
  spaces,
  eof,
  many1WithJoin,
} from "tarsec";
import {
  PrimitiveType,
  ArrayType,
  VariableType,
  TypeHint,
  StringLiteralType,
  NumberLiteralType,
  BooleanLiteralType,
} from "@/types";
import { optionalSpaces } from "@/parsers/utils";

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
  capture(variableTypeParser, "variableType")
);
