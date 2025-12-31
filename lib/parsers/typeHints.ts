import { optionalSpaces } from "@/parsers/utils";
import {
  ArrayType,
  BooleanLiteralType,
  NumberLiteralType,
  ObjectProperty,
  ObjectType,
  PrimitiveType,
  StringLiteralType,
  TypeAlias,
  TypeAliasVariable,
  TypeHint,
  UnionType,
  VariableType,
} from "@/types";
import {
  alphanum,
  capture,
  captureCaptures,
  char,
  digit,
  many1,
  many1Till,
  many1WithJoin,
  optional,
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
} from "tarsec";

export const primitiveTypeParser: Parser<PrimitiveType> = seqC(
  set("type", "primitiveType"),
  capture(or(str("number"), str("string"), str("boolean")), "value")
);

export const typeAliasVariableParser: Parser<TypeAliasVariable> = seqC(
  set("type", "typeAliasVariable"),
  capture(many1WithJoin(alphanum), "aliasName")
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

export const objectPropertyDelimiter = seqR(
  optionalSpaces,
  char(";"),
  optionalSpaces
);

export const objectPropertyParser: Parser<ObjectProperty> = (
  input: string
): ParserResult<ObjectProperty> => {
  const parser = seqC(
    capture(many1WithJoin(alphanum), "key"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(variableTypeParser, "value"),
  );
  return parser(input);
};

export const objectPropertyDescriptionParser: Parser<{ description: string }> = seqC(
  char("#"),
  optionalSpaces,
  capture(many1Till(char(";")), "description")
)

export const objectPropertyWithDescriptionParser: Parser<ObjectProperty> = seqC(
  captureCaptures(objectPropertyParser),
  spaces,
  captureCaptures(objectPropertyDescriptionParser)
)

export const objectTypeParser: Parser<ObjectType> = (
  input: string
): ParserResult<ObjectType> => {
  const parser = seqC(
    set("type", "objectType"),
    char("{"),
    optionalSpaces,
    capture(sepBy(objectPropertyDelimiter, or(objectPropertyWithDescriptionParser, objectPropertyParser)), "properties"),
    optionalSpaces,
    char("}")
  );
  return parser(input);
};

export const unionItemParser: Parser<VariableType> = or(
  objectTypeParser,
  angleBracketsArrayTypeParser,
  arrayTypeParser,
  stringLiteralTypeParser,
  numberLiteralTypeParser,
  booleanLiteralTypeParser,
  primitiveTypeParser,
  typeAliasVariableParser
);

const pipe = seqR(optionalSpaces, str("|"), optionalSpaces);

export const unionTypeParser: Parser<UnionType> = (
  input: string
): ParserResult<UnionType> => {
  const parser = seqC(
    set("type", "unionType"),
    capture(sepBy(pipe, unionItemParser), "types")
  );
  const result = parser(input);

  // Union types must have at least 2 types (i.e., at least one "|")
  if (result.success && result.result.types.length < 2) {
    return {
      success: false,
      rest: input,
      message: "Union type must have at least 2 types",
    };
  }

  return result;
};

export const variableTypeParser: Parser<VariableType> = or(
  objectTypeParser,
  unionTypeParser,
  angleBracketsArrayTypeParser,
  arrayTypeParser,
  stringLiteralTypeParser,
  numberLiteralTypeParser,
  booleanLiteralTypeParser,
  primitiveTypeParser,
  typeAliasVariableParser
);

export const typeHintParser: Parser<TypeHint> = seqC(
  set("type", "typeHint"),
  capture(many1Till(space), "variableName"),
  optionalSpaces,
  str("::"),
  optionalSpaces,
  capture(variableTypeParser, "variableType")
);

export const typeAliasParser: Parser<TypeAlias> = seqC(
  set("type", "typeAlias"),
  str("type"),
  spaces,
  capture(many1WithJoin(alphanum), "aliasName"),
  optionalSpaces,
  str("="),
  optionalSpaces,
  capture(variableTypeParser, "aliasedType")
);
