import {
  optionalSpaces,
  optionalSpacesOrNewline,
  varNameChar,
} from "./utils.js";
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
  UnionType,
  VariableType,
} from "../types.js";
import {
  capture,
  captureCaptures,
  char,
  count,
  digit,
  many1Till,
  many1WithJoin,
  newline,
  oneOf,
  optional,
  or,
  parseError,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  seqR,
  set,
  spaces,
  str,
  success,
  trace,
  label,
} from "tarsec";
import { withLoc } from "./loc.js";
import { optionalSemicolon } from "./parserUtils.js";
import { commentParser } from "./comment.js";
import { multiLineCommentParser } from "./multiLineComment.js";

export const primitiveTypeParser: Parser<PrimitiveType> = trace(
  "primitiveTypeParser",
  seqC(
    set("type", "primitiveType"),
    capture(
      or(
        str("number"),
        str("string"),
        str("boolean"),
        str("undefined"),
        str("void"),
        str("null"),
        str("any"),
        str("unknown"),
      ),
      "value",
    ),
  ),
);

export const typeAliasVariableParser: Parser<TypeAliasVariable> = trace(
  "typeAliasVariableParser",
  seqC(
    set("type", "typeAliasVariable"),
    capture(many1WithJoin(varNameChar), "aliasName"),
  ),
);

export const arrayTypeParser: Parser<ArrayType> = (input: string) => {
  const parser = trace(
    "arrayTypeParser",
    seqC(
      set("type", "arrayType"),
      capture(
        or(objectTypeParser, primitiveTypeParser, typeAliasVariableParser),
        "elementType",
      ),
      capture(count(str("[]")), "arrayDepth"),
    ),
  );
  const result = parser(input);
  if (result.success) {
    // Wrap the elementType in ArrayType according to arrayDepth
    let wrappedType: VariableType = result.result.elementType;
    for (let i = 0; i < result.result.arrayDepth; i++) {
      wrappedType = {
        type: "arrayType",
        elementType: wrappedType,
      };
    }
    return {
      success: true,
      rest: result.rest,
      result: wrappedType as ArrayType,
    };
  }
  return result;
};
export const angleBracketsArrayTypeParser: Parser<ArrayType> = trace(
  "angleBracketsArrayTypeParser",
  seqC(
    set("type", "arrayType"),
    str("array"),
    char("<"),
    captureCaptures(
      parseError(
        "expected a type name followed by `>`, e.g. `array<string>`",
        capture(
          or(primitiveTypeParser, typeAliasVariableParser),
          "elementType",
        ),
        char(">"),
      ),
    ),
  ),
);

export const stringLiteralTypeParser: Parser<StringLiteralType> = trace(
  "stringLiteralTypeParser",
  seqC(
    set("type", "stringLiteralType"),
    char('"'),
    capture(many1Till(char('"')), "value"),
    char('"'),
  ),
);

export const numberLiteralTypeParser: Parser<NumberLiteralType> = trace(
  "numberLiteralTypeParser",
  seqC(
    set("type", "numberLiteralType"),
    capture(many1WithJoin(or(char("-"), char("."), digit)), "value"),
  ),
);

export const booleanLiteralTypeParser: Parser<BooleanLiteralType> = trace(
  "booleanLiteralTypeParser",
  seqC(
    set("type", "booleanLiteralType"),
    capture(or(str("true"), str("false")), "value"),
  ),
);

export const objectPropertyDelimiter = seqR(
  optionalSpaces,
  oneOf(",;"),
  optionalSpacesOrNewline,
);

export const objectPropertyParser: Parser<ObjectProperty> = trace(
  "objectPropertyParser",
  (input: string): ParserResult<ObjectProperty> => {
    const parser = seqC(
      capture(many1WithJoin(varNameChar), "key"),
      optionalSpaces,
      capture(optional(char("?")), "isOptional"),
      char(":"),
      optionalSpaces,
      capture(variableTypeParser, "value"),
    );
    const result = parser(input);
    if (!result.success) {
      return result;
    }
    const { key, isOptional, value } = result.result;
    if (!isOptional) {
      return success(
        {
          key,
          value,
        },
        result.rest,
      );
    }

    if (value.type === "unionType") {
      // If it's already a union, just add undefined to the list of types
      return success(
        {
          key,
          value: {
            type: "unionType",
            types: [
              ...value.types,
              { type: "primitiveType", value: "undefined" },
            ],
          },
        },
        result.rest,
      );
    }

    // If it's not a union, create a new union with the original type and undefined
    return success(
      {
        key,
        value: {
          type: "unionType",
          types: [value, { type: "primitiveType", value: "undefined" }],
        },
      },
      result.rest,
    );
  },
);

export const objectPropertyDescriptionParser: Parser<{ description: string }> =
  trace(
    "objectPropertyDescriptionParser",
    seqC(
      char("#"),
      optionalSpaces,
      capture(many1Till(oneOf(",;\n")), "description"),
    ),
  );

export const objectPropertyWithDescriptionParser: Parser<ObjectProperty> =
  trace(
    "objectPropertyWithDescriptionParser",
    seqC(
      captureCaptures(objectPropertyParser),
      spaces,
      captureCaptures(objectPropertyDescriptionParser),
    ),
  );

export const objectTypeParser: Parser<ObjectType> = trace(
  "objectTypeParser",
  (input: string): ParserResult<ObjectType> => {
    const parser = seqC(
      set("type", "objectType"),
      char("{"),
      optionalSpacesOrNewline,
      capture(
        sepBy(
          objectPropertyDelimiter,
          or(
            objectPropertyWithDescriptionParser,
            objectPropertyParser,
            commentParser,
            multiLineCommentParser,
          ),
        ),
        "properties",
      ),
      optionalSpacesOrNewline,
      parseError(
        "Expected `}`. Did you forget to add a comma between object properties?",
        char("}"),
      ),
      optionalSpacesOrNewline,
    );
    const result = parser(input);
    if (!result.success) {
      return result;
    }
    // Filter out comment properties from the final result
    const properties = result.result.properties.filter(
      (prop): prop is ObjectProperty =>
        !("type" in prop) ||
        (prop.type !== "comment" && prop.type !== "multiLineComment"),
    );

    return success(
      {
        type: "objectType",
        properties,
      },
      result.rest,
    );
  },
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
    typeAliasVariableParser,
  ),
);

const pipe = seqR(optionalSpacesOrNewline, str("|"), optionalSpacesOrNewline);

export const _unionTypeParser: Parser<UnionType> = (
  input: string,
): ParserResult<UnionType> => {
  const parser = seqC(
    set("type", "unionType"),
    optional(pipe),
    capture(sepBy(pipe, unionItemParser), "types"),
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
  _unionTypeParser,
);

export const variableTypeParser: Parser<VariableType> = trace(
  "variableTypeParser",
  or(
    unionTypeParser,
    arrayTypeParser,
    objectTypeParser,
    angleBracketsArrayTypeParser,
    stringLiteralTypeParser,
    numberLiteralTypeParser,
    booleanLiteralTypeParser,
    primitiveTypeParser,
    typeAliasVariableParser,
  ),
);

export const typeAliasParser: Parser<TypeAlias> = label("a type alias", withLoc(trace(
  "typeAliasParser",
  seqC(
    set("type", "typeAlias"),
    str("type"),
    spaces,
    captureCaptures(
      parseError(
        "expected a statement of the form `type Foo = X' where X can be a union, array, object, type alias, or primitive type`",
        capture(many1WithJoin(varNameChar), "aliasName"),
        optionalSpaces,
        str("="),
        optionalSpaces,
        capture(variableTypeParser, "aliasedType"),
        optionalSemicolon,
        optionalSpacesOrNewline,
      ),
    ),
  ),
)));
