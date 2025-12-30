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
} from "tarsec";
import { PrimitiveType, ArrayType, VariableType, TypeHint } from "../types";
import { optionalSpaces } from "./utils";

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
