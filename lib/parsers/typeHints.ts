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
  trace,
} from "tarsec";
import { optionalSemicolon } from "./parserUtils";

export const primitiveTypeParser: Parser<PrimitiveType> = trace(
  "primitiveTypeParser",
  seqC(
    set("type", "primitiveType"),
    capture(or(str("number"), str("string"), str("boolean")), "value")
  )
);

export const typeAliasVariableParser: Parser<TypeAliasVariable> = trace(
  "typeAliasVariableParser",
  seqC(
    set("type", "typeAliasVariable"),
    capture(many1WithJoin(alphanum), "aliasName")
  )
);

export const arrayTypeParser: Parser<ArrayType> = trace(
  "arrayTypeParser",
  seqC(
    set("type", "arrayType"),
    capture(primitiveTypeParser, "elementType"),
    str("[]")
  )
);
export const angleBracketsArrayTypeParser: Parser<ArrayType> = trace(
  "angleBracketsArrayTypeParser",
  seqC(
    set("type", "arrayType"),
    str("array"),
    char("<"),
    capture(primitiveTypeParser, "elementType"),
    char(">")
  )
);

export const stringLiteralTypeParser: Parser<StringLiteralType> = trace(
  "stringLiteralTypeParser",
  seqC(
    set("type", "stringLiteralType"),
    char('"'),
    capture(many1Till(char('"')), "value"),
    char('"')
  )
);

export const numberLiteralTypeParser: Parser<NumberLiteralType> = trace(
  "numberLiteralTypeParser",
  seqC(
    set("type", "numberLiteralType"),
    capture(many1WithJoin(or(char("-"), char("."), digit)), "value")
  )
);

export const booleanLiteralTypeParser: Parser<BooleanLiteralType> = trace(
  "booleanLiteralTypeParser",
  seqC(
    set("type", "booleanLiteralType"),
    capture(or(str("true"), str("false")), "value")
  )
);

export const objectPropertyDelimiter = seqR(
  optionalSpaces,
  char(";"),
  optionalSpaces
);

export const objectPropertyParser: Parser<ObjectProperty> = trace(
  "objectPropertyParser",
  (input: string): ParserResult<ObjectProperty> => {
    const parser = seqC(
      capture(many1WithJoin(alphanum), "key"),
      optionalSpaces,
      char(":"),
      optionalSpaces,
      capture(variableTypeParser, "value")
    );
    return parser(input);
  }
);

export const objectPropertyDescriptionParser: Parser<{ description: string }> =
  seqC(char("#"), optionalSpaces, capture(many1Till(char(";")), "description"));

export const objectPropertyWithDescriptionParser: Parser<ObjectProperty> =
  trace(
    "objectPropertyWithDescriptionParser",
    seqC(
      captureCaptures(objectPropertyParser),
      spaces,
      captureCaptures(objectPropertyDescriptionParser)
    )
  );

export const objectTypeParser: Parser<ObjectType> = trace(
  "objectTypeParser",
  (input: string): ParserResult<ObjectType> => {
    const parser = seqC(
      set("type", "objectType"),
      char("{"),
      optionalSpaces,
      capture(
        sepBy(
          objectPropertyDelimiter,
          or(objectPropertyWithDescriptionParser, objectPropertyParser)
        ),
        "properties"
      ),
      optionalSpaces,
      char("}")
    );
    return parser(input);
  }
);

export const unionItemParser: Parser<VariableType> = trace(
  "unionItemParser",
  or(
    objectTypeParser,
    angleBracketsArrayTypeParser,
    arrayTypeParser,
    stringLiteralTypeParser,
    numberLiteralTypeParser,
    booleanLiteralTypeParser,
    primitiveTypeParser,
    typeAliasVariableParser
  )
);

const pipe = seqR(optionalSpaces, str("|"), optionalSpaces);

export const _unionTypeParser: Parser<UnionType> = (
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

export const unionTypeParser: Parser<UnionType> = trace(
  "unionTypeParser",
  _unionTypeParser
);

export const variableTypeParser: Parser<VariableType> = trace(
  "variableTypeParser",
  or(
    objectTypeParser,
    unionTypeParser,
    angleBracketsArrayTypeParser,
    arrayTypeParser,
    stringLiteralTypeParser,
    numberLiteralTypeParser,
    booleanLiteralTypeParser,
    primitiveTypeParser,
    typeAliasVariableParser
  )
);

export const typeHintParser: Parser<TypeHint> = trace(
  "typeHintParser",
  seqC(
    set("type", "typeHint"),
    capture(many1Till(space), "variableName"),
    optionalSpaces,
    str("::"),
    optionalSpaces,
    capture(variableTypeParser, "variableType"),
    optionalSemicolon
  )
);

export const typeAliasParser: Parser<TypeAlias> = trace(
  "typeAliasParser",
  seqC(
    set("type", "typeAlias"),
    str("type"),
    spaces,
    capture(many1WithJoin(alphanum), "aliasName"),
    optionalSpaces,
    str("="),
    optionalSpaces,
    capture(variableTypeParser, "aliasedType"),
    optionalSemicolon
  )
);
