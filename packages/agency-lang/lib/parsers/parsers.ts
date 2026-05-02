// =============================================================================
// Combined parser file — all parsers from lib/parsers/ merged into one file
// to eliminate circular dependencies. Uses lazy() for forward references.
// =============================================================================

// --- tarsec imports (combined from all parser files) ---
import {
  anyChar,
  between,
  buildExpressionParser,
  capture,
  captureCaptures,
  char,
  count,
  debug,
  digit,
  fail,
  failure,
  label,
  lazy,
  letter,
  many,
  many1,
  many1Till,
  many1WithJoin,
  manyTill,
  manyWithJoin,
  map,
  newline,
  noneOf,
  not,
  oneOf,
  optional,
  or,
  parseError,
  Parser,
  ParserResult,
  quotedString,
  regexParser,
  sepBy,
  sepBy1,
  seq,
  seqC,
  seqR,
  set,
  space,
  spaces,
  str,
  succeed,
  success,
  trace,
  withSpan,
} from "tarsec";

// --- Type imports (combined from all parser files) ---
import { SourceLocation } from "../types/base.js";
import {
  AccessChainElement,
  AgencyNode,
  Assignment,
  BooleanLiteral,
  DocString,
  Expression,
  FunctionCall,
  FunctionDefinition,
  VALID_CALLBACK_NAMES,
  FunctionParameter,
  InterpolationSegment,
  Literal,
  MultiLineStringLiteral,
  NamedArgument,
  NewLine,
  NullLiteral,
  NumberLiteral,
  PromptSegment,
  RegexLiteral,
  StringLiteral,
  TextSegment,
  VariableNameLiteral,
  VariableType,
  AgencyComment,
  AgencyMultiLineComment,
  ArrayType,
  BlockType,
  BooleanLiteralType,
  NumberLiteralType,
  ObjectProperty,
  ObjectType,
  PrimitiveType,
  ResultType,
  StringLiteralType,
  TypeAlias,
  TypeAliasVariable,
  UnionType,
  Tag,
} from "../types.js";
import { GraphNodeDefinition, Visibility } from "../types/graphNode.js";
import { ForLoop } from "../types/forLoop.js";
import { WhileLoop } from "../types/whileLoop.js";
import { ParallelBlock, SeqBlock } from "../types/parallelBlock.js";
import { IfElse } from "../types/ifElse.js";
import { ValueAccess } from "../types/access.js";
import { BlockArgument } from "../types/blockArgument.js";
import { BinOpExpression, Operator } from "../types/binop.js";
import { Placeholder } from "../types/placeholder.js";
import { TryExpression } from "../types/tryExpression.js";
import { ClassDefinition, ClassField, ClassMethod, NewExpression } from "../types/classDefinition.js";
import { SchemaExpression } from "../types/schemaExpression.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { GotoStatement } from "../types/gotoStatement.js";
import { DebuggerStatement } from "../types/debuggerStatement.js";
import { isAgencyImport } from "../importPaths.js";
import { Keyword, keywords, createKeyword } from "@/types/keyword.js";
import { Skill } from "@/types/skill.js";
import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
  SplatExpression,
} from "../types/dataStructures.js";
import {
  DefaultImport,
  ImportNameType,
  ImportNodeStatement,
  ImportStatement,
  NamedImport,
  NamespaceImport,
} from "../types/importStatement.js";
import { DefaultCase, MatchBlockCase } from "../types/matchBlock.js";
import { MessageThread } from "@/types/messageThread.js";
import { HandleBlock } from "@/types/handleBlock.js";
import { WithModifier } from "@/types/withModifier.js";

// =============================================================================
// utils.ts
// =============================================================================

export const optionalSpacesOrNewline = many(space);
export const optionalSpaces = many(oneOf(" \t"));
export const backtick = char("`");
export const comma = seqR(optionalSpaces, char(","), optionalSpaces);
export const plusSign = seqR(optionalSpaces, char("+"), optionalSpaces);

export const commaWithNewline = seqR(
  optionalSpacesOrNewline,
  char(","),
  optionalSpacesOrNewline,
);
export const varNameChar: Parser<string> = oneOf(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_",
);

// =============================================================================
// loc.ts
// =============================================================================

/* withLoc appends accurate line and column numbers to different symbols in the agency code.
However, because every agency code gets rendered in a template that imports some standard functions,
the line numbers would be off if we didn't account for the template lines.
*/
export const AGENCY_TEMPLATE_OFFSET = 2;

/**
 * Wraps a parser to add a `loc` field from tarsec's withSpan.
 * Converts Span { start: Position, end: Position } to SourceLocation { line, col, start, end }.
 */
export function withLoc<T>(
  parser: Parser<T>,
): Parser<T & { loc: SourceLocation }> {
  const spanned = withSpan(parser);
  return (input: string) => {
    const result = spanned(input);
    if (!result.success) return result;
    const { value, span } = result.result;
    const loc: SourceLocation = {
      line: span.start.line - AGENCY_TEMPLATE_OFFSET,
      col: span.start.column,
      start: span.start.offset,
      end: span.end.offset,
    };
    return {
      success: true as const,
      result: { ...value, loc } as T & { loc: SourceLocation },
      rest: result.rest,
    };
  };
}

// =============================================================================
// parserUtils.ts
// =============================================================================

export const optionalSemicolon = optional(char(";"));

export function removeQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

export const oneOfStr = <T extends string>(strs: readonly T[]): Parser<T> => {
  return or(...strs.map((s) => str(s)));
};

// =============================================================================
// newline.ts
// =============================================================================

export const newLineParser: Parser<NewLine> = seqC(
  set("type", "newLine"),
  or(str("\r\n"), str("\n")),
);

// =============================================================================
// comment.ts
// =============================================================================

export const commentParser: Parser<AgencyComment> = (input: string) => {
  const parser = seqC(
    set("type", "comment"),
    optionalSpaces,
    str("//"),
    capture(manyTill(newline), "content"),
    optionalSpacesOrNewline,
  );
  return parser(input);
};

// =============================================================================
// multiLineComment.ts
// =============================================================================

const joinChars = (chars: string[]) => chars.join("");

export const multiLineCommentParser: Parser<AgencyMultiLineComment> = (
  input: string,
) => {
  const parser = seqC(
    set("type", "multiLineComment"),
    set("isDoc", false as boolean),
    optionalSpaces,
    capture(map(between(str("/*"), str("*/"), anyChar), joinChars), "content"),
  );
  const result = parser(input);
  if (result.success) {
    const content = result.result.content;
    if (content.startsWith("*")) {
      result.result.isDoc = true;
      result.result.content = content.slice(1);
    }
  }
  return result;
};

// =============================================================================
// literals.ts
// =============================================================================

export const stringTextSegmentParser: Parser<TextSegment> = map(
  many1Till(or(char('"'), char("`"), str("${"))),
  (text) => ({
    type: "text",
    value: text,
  }),
);

export const multiLineStringTextSegmentParser: Parser<TextSegment> = map(
  many1Till(or(str('"""'), str("${"))),
  (text) => ({
    type: "text",
    value: text,
  }),
);

export const interpolationSegmentParser: Parser<InterpolationSegment> = (
  input: string,
) => {
  const parser = seqC(
    char("$"),
    char("{"),
    capture(lazy(() => exprParser), "expression"),
    char("}"),
  );

  const result = parser(input);
  if (!result.success) {
    return result;
  }

  return success(
    {
      type: "interpolation" as const,
      expression: result.result.expression,
    },
    result.rest,
  );
};

const objectParser = (input: string): ParserResult<Record<string, any>> => {
  const kvParser = trace(
    "objectKVParser",
    seqC(
      optionalSpaces,
      optional(char('"')),
      capture(manyWithJoin(noneOf('":\n\t ')), "key"),
      optional(char('"')),
      optionalSpaces,
      char(":"),
      optionalSpaces,
      capture(
        or(literalParser, objectParser),
        "value",
      ),
    ),
  );

  const arrayToObj = (arr: { key: string; value: any }[]) => {
    const obj: Record<string, any> = {};
    arr.forEach(({ key, value }) => {
      obj[key] = value;
    });
    return obj;
  };

  const parser = seq(
    [
      char("{"),
      optionalSpacesOrNewline,
      capture(map(sepBy(commaWithNewline, kvParser), arrayToObj), "entries"),
      optionalSpacesOrNewline,
      char("}"),
    ],
    (_, captures) => {
      return captures.entries;
    },
  );

  return parser(input);
};

export const numberParser: Parser<NumberLiteral> = label("a number", (input: string): ParserResult<NumberLiteral> => {
  const parser = seqC(
    set("type", "number"),
    capture(map(many1WithJoin(or(char("-"), char("."), char("_"), digit)), (v) => v.replace(/_/g, "")), "value"),
  );
  return parser(input);
});

export const regexLiteralParser: Parser<RegexLiteral> = label("a regex", (input: string): ParserResult<RegexLiteral> => {
  const parser = seqC(
    set("type", "regex"),
    str("re/"),
    capture(many1WithJoin(or(
      str("\\/"),
      noneOf("/\n"),
    )), "pattern"),
    char("/"),
    capture(manyWithJoin(oneOf("dgimsuy")), "flags"),
  );
  return parser(input);
});

export const simpleStringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  oneOf('"`'),
  capture(
    map(stringTextSegmentParser, (x) => [x]),
    "segments",
  ),
  oneOf('"`'),
);

export const _stringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  oneOf('"`'),
  capture(
    many(or(stringTextSegmentParser, interpolationSegmentParser)),
    "segments",
  ),
  oneOf('"`'),
);

export const stringParser: Parser<StringLiteral> = label("a string", (input: string) => {
  const parser = sepBy1(plusSign, or(_stringParser, variableNameParser));
  const result = parser(input);
  if (!result.success) {
    return result;
  }

  const parsed = result.result;
  if (parsed.length === 1 && parsed[0].type === "variableName") {
    return failure("Expected string literal, got variable name", input);
  }

  const segments: (TextSegment | InterpolationSegment)[] = [];
  parsed.forEach((part) => {
    if (part.type === "string") {
      segments.push(...part.segments);
    } else if (part.type === "variableName") {
      segments.push({
        type: "interpolation",
        expression: part,
      });
    }
  });
  return success(
    {
      type: "string" as const,
      segments,
    },
    result.rest,
  );
});

export const multiLineStringParser: Parser<MultiLineStringLiteral> = seqC(
  set("type", "multiLineString"),
  str('"""'),
  capture(
    many(or(multiLineStringTextSegmentParser, interpolationSegmentParser)),
    "segments",
  ),
  str('"""'),
);

export const variableNameParser: Parser<VariableNameLiteral> = label("an identifier", (
  input: string,
) => {
  const parser = seq(
    [
      set("type", "variableName"),
      capture(or(letter, char("_")), "init"),
      capture(manyWithJoin(varNameChar), "value"),
    ],
    (_, captures) => {
      return {
        type: "variableName" as const,
        value: `${captures.init}${captures.value}`,
      };
    },
  );

  return parser(input);
});

export const booleanParser: Parser<BooleanLiteral> = label("a boolean", (input: string): ParserResult<BooleanLiteral> => {
  const parser = seqC(
    set("type", "boolean"),
    capture(
      or(
        map(str("true"), () => true),
        map(str("false"), () => false),
      ),
      "value",
    ),
  );
  return parser(input);
});

export const nullParser: Parser<NullLiteral> = label("null", seqC(
  set("type", "null"),
  str("null"),
));

export const literalParser: Parser<Literal> = or(
  nullParser,
  booleanParser,
  numberParser,
  multiLineStringParser,
  stringParser,
  variableNameParser,
);

export const literalParserNoVarName: Parser<Literal> = or(
  nullParser,
  booleanParser,
  numberParser,
  multiLineStringParser,
  stringParser,
);

// no string concat, no prompt strings
export function simpleLiteralParser(input: string): ParserResult<Literal> {
  const parser = or(
    booleanParser,
    numberParser,
    _stringParser,
    variableNameParser,
  );
  return parser(input);
}

// =============================================================================
// typeHints.ts
// =============================================================================

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
        str("object"),
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
    capture(map(many1WithJoin(or(char("-"), char("."), char("_"), digit)), (v) => v.replace(/_/g, "")), "value"),
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
  oneOf(",;\n"),
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
    lazy(() => blockTypeParser),
    objectTypeParser,
    angleBracketsArrayTypeParser,
    arrayTypeParser,
    lazy(() => resultTypeParser),
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

// Block type: () => string, (number) => any, (string, number) => boolean
// Params are positional (no names in the type annotation).
export const blockTypeParser: Parser<BlockType> = trace(
  "blockTypeParser",
  (input: string): ParserResult<BlockType> => {
    const parser = seqC(
      set("type", "blockType"),
      char("("),
      optionalSpaces,
      capture(
        sepBy(
          seqR(optionalSpaces, char(","), optionalSpaces),
          lazy(() => variableTypeParser),
        ),
        "paramTypes",
      ),
      optionalSpaces,
      char(")"),
      optionalSpaces,
      str("=>"),
      optionalSpaces,
      capture(lazy(() => variableTypeParser), "returnType"),
    );
    const result = parser(input);
    if (!result.success) return result;
    return success(
      {
        type: "blockType" as const,
        params: result.result.paramTypes.map((t: VariableType) => ({
          name: "",
          typeAnnotation: t,
        })),
        returnType: result.result.returnType,
      },
      result.rest,
    );
  },
);

export const resultTypeParser: Parser<ResultType> = trace(
  "resultTypeParser",
  or(
    // Result<SuccessType, FailureType> — two type params
    seqC(
      set("type", "resultType"),
      str("Result"),
      char("<"),
      captureCaptures(seqC(
        capture(lazy(() => variableTypeParser), "successType"),
        optionalSpaces,
        char(","),
        optionalSpaces,
        capture(lazy(() => variableTypeParser), "failureType"),
        char(">"),
      )),
    ),
    // Result<SuccessType> — single type param (sugar for Result<SuccessType, string>)
    seqC(
      set("type", "resultType"),
      str("Result"),
      char("<"),
      captureCaptures(seqC(
        capture(lazy(() => variableTypeParser), "successType"),
        char(">"),
      )),
      set("failureType", { type: "primitiveType", value: "string" }),
    ),
    // Bare Result (sugar for Result<any, any>)
    // Use not(varNameChar) to avoid matching "ResultFoo" as bare Result
    seqC(
      set("type", "resultType"),
      str("Result"),
      not(varNameChar),
      set("successType", { type: "primitiveType", value: "any" }),
      set("failureType", { type: "primitiveType", value: "any" }),
    ),
  ),
);

export const variableTypeParser: Parser<VariableType> = trace(
  "variableTypeParser",
  or(
    blockTypeParser,
    unionTypeParser,
    arrayTypeParser,
    objectTypeParser,
    angleBracketsArrayTypeParser,
    resultTypeParser,
    stringLiteralTypeParser,
    numberLiteralTypeParser,
    booleanLiteralTypeParser,
    primitiveTypeParser,
    typeAliasVariableParser,
  ),
);

const baseTypeAliasParser: Parser<TypeAlias> = withLoc(trace(
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
));

export const typeAliasParser: Parser<TypeAlias> = label("a type alias",
  (input: string) => {
    const exportResult = exportKeywordParser(input);
    if (!exportResult.success) return exportResult;
    const isExported = exportResult.result;

    const baseResult = baseTypeAliasParser(exportResult.rest);
    if (!baseResult.success) return baseResult;

    const result = { ...baseResult.result };
    if (isExported) result.exported = true;
    return { ...baseResult, result };
  },
);

// =============================================================================
// keyword.ts
// =============================================================================

export const keywordParser: Parser<Keyword> = (input) => {
  const parser = seqC(
    capture(or(...keywords.map(str)), "keyword"),
    optionalSemicolon,
  );
  const result = parser(input);
  if (!result.success) {
    return result;
  }
  const { keyword } = result.result;
  return success(createKeyword(keyword), result.rest);
};

// =============================================================================
// debuggerStatement.ts
// =============================================================================

export const debuggerParser: Parser<DebuggerStatement> = withLoc(seqC(
  set("type", "debuggerStatement"),
  set("isUserAdded", true),
  str("debugger"),
  char("("),
  optional(capture(map(quotedString, removeQuotes), "label")),
  char(")"),
  optionalSemicolon,
  optionalSpacesOrNewline,
));

// =============================================================================
// skill.ts
// =============================================================================

export function _skillParser(input: string): ParserResult<Skill> {
  const parser = trace(
    "skillParser",
    seqC(
      set("type", "skill"),
      or(str("skills"), str("skill")),
      spaces,
      captureCaptures(
        parseError(
          "expected a quoted filepath, e.g. skill 'path/to/file.ts'",
          capture(map(quotedString, removeQuotes), "filepath"),
        ),
      ),
    ),
  );

  const result = parser(input);
  if (!result.success) {
    return result;
  }
  if (result.result.filepath.length === 0) {
    return failure("Filepath cannot be empty", input);
  }
  return result;
}

export function _skillParserWithDescription(
  input: string,
): ParserResult<Skill> {
  const parser = trace(
    "skillParser",
    seqC(
      set("type", "skill"),
      or(str("skills"), str("skill")),
      spaces,
      capture(map(quotedString, removeQuotes), "filepath"),
      comma,
      capture(map(quotedString, removeQuotes), "description"),
    ),
  );

  const result = parser(input);
  if (!result.success) {
    return result;
  }
  if (result.result.filepath.length === 0) {
    return failure("Filepath cannot be empty", input);
  }
  if (result.result.description.length === 0) {
    return failure("Description cannot be empty", input);
  }
  return result;
}

export const skillParser = (input: string) => {
  return or(_skillParserWithDescription, _skillParser)(input);
};

// =============================================================================
// tag.ts
// =============================================================================

// A single tag argument: either a quoted string or a bare identifier
// Both are normalized to plain strings
const stringArg = map(quotedString, removeQuotes);
const identArg = many1WithJoin(varNameChar);
const tagArg = or(stringArg, identArg);

// Parenthesized argument list: (arg1, arg2) or ("string arg")
const tagArgsList = map(
  seqC(
    char("("),
    optionalSpaces,
    capture(sepBy(comma, tagArg), "args"),
    optionalSpaces,
    char(")"),
  ),
  (result) => result.args,
);

// The full tag: @name or @name(args)
const _tagParserInner = trace(
  "tagParser",
  seqC(
    set("type", "tag"),
    char("@"),
    capture(many1WithJoin(varNameChar), "name"),
    capture(
      or(tagArgsList, succeed([] as string[])),
      "arguments",
    ),
    optionalSemicolon,
  ),
);

export const tagParser = label("a tag", withLoc(_tagParserInner));

// =============================================================================
// dataStructures.ts
// =============================================================================

export const splatParser: Parser<SplatExpression> = seqC(
  set("type", "splat"),
  str("..."),
  capture(lazy(() => exprParser), "value"),
);

export const agencyArrayParser: Parser<AgencyArray> = (
  input: string,
): ParserResult<AgencyArray> => {
  const parser = trace(
    "agencyArrayParser",
    seqC(
      set("type", "agencyArray"),
      char("["),
      optionalSpacesOrNewline,
      capture(
        sepBy(
          commaWithNewline,
          or(
            splatParser,
            lazy(() => exprParser),
          ),
        ),
        "items",
      ),
      optionalSpacesOrNewline,
      char("]"),
    ),
  );

  return parser(input);
};

export const agencyObjectKVParser: Parser<AgencyObjectKV> = (
  input: string,
): ParserResult<AgencyObjectKV> => {
  const parser = trace(
    "agencyObjectKVParser",
    seqC(
      optionalSpaces,
      optional(char('"')),
      capture(many1WithJoin(varNameChar), "key"),
      optional(char('"')),
      optionalSpaces,
      char(":"),
      optionalSpaces,
      capture(
        lazy(() => exprParser),
        "value",
      ),
    ),
  );

  return parser(input);
};

export const agencyObjectParser: Parser<AgencyObject> = seqC(
  set("type", "agencyObject"),
  char("{"),
  optionalSpacesOrNewline,
  capture(
    or(
      sepBy(commaWithNewline, or(splatParser, agencyObjectKVParser)),
      succeed([]),
    ),
    "entries",
  ),
  optional(char(",")),
  optionalSpacesOrNewline,
  char("}"),
);

// =============================================================================
// functionCall.ts
// =============================================================================

const namedArgumentParser: Parser<NamedArgument> = trace(
  "namedArgumentParser",
  seqC(
    set("type", "namedArgument"),
    capture(many1WithJoin(varNameChar), "name"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(lazy(() => exprParser), "value"),
  ),
);

// Shared argument list parser: (arg1, arg2, \x -> expr, ...)
// Used by both _functionCallParser and callChainParser.
const argumentListParser = seqC(
  char("("),
  optionalSpaces,
  capture(
    sepBy(
      comma,
      or(
        namedArgumentParser,
        splatParser,
        lazy(() => inlineBlockParser),
        lazy(() => exprParser),
      ),
    ),
    "arguments",
  ),
  optionalSpaces,
  char(")"),
);

// Extract inline block from parsed arguments into a separate block field.
// Returns { arguments, block } or a failure if there are multiple inline blocks,
// or if an inline block conflicts with an existing trailing block.
function extractInlineBlock(
  args: ArgWithBlock[],
  existingBlock: BlockArgument | undefined,
  input: string,
): { success: true; arguments: FunctionCall["arguments"]; block?: BlockArgument } | { success: false; error: ParserResult<any> } {
  const inlineBlocks = args.filter((a): a is BlockArgument => a.type === "blockArgument");
  if (inlineBlocks.length > 1) {
    return { success: false, error: failure("A function call cannot have more than one block argument", input) };
  }
  if (inlineBlocks.length === 1) {
    if (existingBlock) {
      return { success: false, error: failure("A function call cannot have both an inline block and a trailing 'as' block", input) };
    }
    return {
      success: true,
      arguments: args.filter((a): a is Exclude<ArgWithBlock, BlockArgument> => a.type !== "blockArgument"),
      block: inlineBlocks[0],
    };
  }
  return { success: true, arguments: args as FunctionCall["arguments"], block: existingBlock };
}

type ArgWithBlock = Expression | SplatExpression | NamedArgument | BlockArgument;

type FunctionCallWithBlock = Omit<FunctionCall, "arguments"> & {
  arguments: ArgWithBlock[]
}

export const _functionCallParser: Parser<FunctionCall> = (input: string) => {
  const parser: Parser<FunctionCallWithBlock> = seqC(
    set("type", "functionCall"),
    capture(many1WithJoin(varNameChar), "functionName"),
    captureCaptures(argumentListParser),
    optionalSpaces,
    optional(
      captureCaptures(
        seqC(
          capture(lazy(() => blockArgumentParser), "block"),
        ),
      ),
    ),
    optionalSemicolon,
    optionalSpacesOrNewline
  );
  const result = parser(input);
  if (!result.success) return result;

  const funcCall = result.result;
  const extracted = extractInlineBlock(funcCall.arguments, funcCall.block, input);
  if (!extracted.success) return extracted.error;
  funcCall.arguments = extracted.arguments;
  funcCall.block = extracted.block;

  return result as ParserResult<FunctionCall>;
};

// functionCallParser is now just _functionCallParser (no async/sync wrappers - handled by valueAccessParser)
export const functionCallParser: Parser<FunctionCall> = label("a function call", _functionCallParser);

// =============================================================================
// access.ts
// =============================================================================

// Parse "?." or "." — returns true for optional, false for regular
const dotParser: Parser<boolean> = or(
  map(str("?."), () => true),
  map(char("."), () => false),
);

// Parse a single chain element: .method(), ?.method(), .property, ?.property, [index], ?.[index]
const dotMethodCallParser = (
  input: string,
): ParserResult<AccessChainElement> => {
  const dotResult = dotParser(input);
  if (!dotResult.success) return failure("expected dot", input);
  const optional = dotResult.result;
  const afterDot = dotResult.rest;

  // First try: functionCall (name + parens)
  const fcResult = _functionCallParser(afterDot);
  if (fcResult.success) {
    return success(
      { kind: "methodCall" as const, functionCall: fcResult.result, ...(optional && { optional: true }) },
      fcResult.rest,
    );
  }

  // Second try: just a property name
  const nameResult = variableNameParser(afterDot);
  if (nameResult.success) {
    return success(
      { kind: "property" as const, name: nameResult.result.value, ...(optional && { optional: true }) },
      nameResult.rest,
    );
  }

  return failure("expected property name or method call after dot", input);
};

// Parse "?.[" or "[" — returns true for optional, false for regular
const bracketParser: Parser<boolean> = or(
  map(str("?.["), () => true),
  map(char("["), () => false),
);

const sliceChainParser: Parser<AccessChainElement> = (input: string) => {
  const parser = seqC(
    capture(bracketParser, "optional"),
    optionalSpaces,
    capture(optional(lazy(() => exprParser)), "start"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(optional(lazy(() => exprParser)), "end"),
    optionalSpaces,
    char("]"),
  );
  const result = parser(input);
  if (!result.success) return result;
  const element: Partial<AccessChainElement> = { kind: "slice" as const };
  if (result.result.start) element.start = result.result.start;
  if (result.result.end) element.end = result.result.end;
  if (result.result.optional) element.optional = true;
  return success(element as AccessChainElement, result.rest);
};

const indexChainParser: Parser<AccessChainElement> = (input: string) => {
  const parser = seqC(
    capture(bracketParser, "optional"),
    optionalSpaces,
    capture(lazy(() => exprParser), "index"),
    optionalSpaces,
    char("]"),
  );
  const result = parser(input);
  if (!result.success) return result;
  return success(
    { kind: "index" as const, index: result.result.index, ...(result.result.optional && { optional: true }) },
    result.rest,
  );
};

// Parse a call chain element: (args) or ?.(args) — calling the result of a previous chain element
// e.g. arr[0](arg1, arg2), getHandlers()[0](), fns[0]?.(5)
const callChainParser: Parser<AccessChainElement> = (input: string) => {
  const optResult = str("?.")(input);
  const isOptional = optResult.success;

  const result = argumentListParser(isOptional ? optResult.rest : input);
  if (!result.success) return failure("expected call arguments", input);

  const extracted = extractInlineBlock(result.result.arguments, undefined, input);
  if (!extracted.success) return extracted.error;

  return success(
    { kind: "call" as const, arguments: extracted.arguments, ...(extracted.block && { block: extracted.block }), ...(isOptional && { optional: true }) },
    result.rest,
  );
};

const chainElementParser: Parser<AccessChainElement> = or(
  dotMethodCallParser,
  callChainParser,
  sliceChainParser,
  indexChainParser,
);

export const _valueAccessParser = (
  input: string,
): ParserResult<VariableNameLiteral | FunctionCall | ValueAccess> => {
  const parser = seqC(
    capture(or(_functionCallParser, variableNameParser), "base"),
    capture(many(chainElementParser), "chain"),
  );
  const result = parser(input);
  if (!result.success)
    return failure("expected value access expression", input);

  const base = result.result.base;
  const chain = result.result.chain;

  if (chain.length === 0) {
    // No chain, return base directly
    return success(base, result.rest);
  } else {
    // Return ValueAccess with base and chain
    return success(
      {
        type: "valueAccess" as const,
        base,
        chain,
      },
      result.rest,
    );
  }
};

export const asyncValueAccessParser = (
  input: string,
): ParserResult<FunctionCall | ValueAccess | VariableNameLiteral> => {
  const parser = seqC(
    str("async"),
    spaces,
    capture(_valueAccessParser, "access"),
  );
  const result = parser(input);
  if (!result.success) return failure("expected async keyword", input);

  return success({ ...result.result.access, async: true }, result.rest);
};

export const syncValueAccessParser = (
  input: string,
): ParserResult<FunctionCall | ValueAccess | VariableNameLiteral> => {
  const parser = seqC(
    oneOfStr(["sync", "await"]),
    spaces,
    capture(_valueAccessParser, "access"),
  );
  const result = parser(input);
  if (!result.success) return failure("expected sync/await keyword", input);

  return success({ ...result.result.access, async: false }, result.rest);
};

export function valueAccessParser(
  input: string,
): ParserResult<VariableNameLiteral | FunctionCall | ValueAccess> {
  const parser = withLoc(
    or(asyncValueAccessParser, syncValueAccessParser, _valueAccessParser),
  );
  return parser(input);
}

// =============================================================================
// expression.ts
// =============================================================================

// --- Unary ! operator ---
// Desugared to BinOpExpression: !x → { op: "!", left: true, right: x }
// The builder must generate `!x`, not `true ! x`.
//
// Note: unary `-` is NOT included. Negative number literals like `-42` are
// already handled by numberParser in literals.ts. Adding unary `-` would
// create ambiguity where `-42` parses as `0 - 42`.
const unaryNotParser: Parser<Expression> = (input: string) => {
  const bangResult = char("!")(input);
  if (!bangResult.success) return bangResult;
  // Recurse to atom (not exprParser) so `!` binds tightly: `!x && y` = `(!x) && y`
  const atomResult = atom(bangResult.rest);
  if (!atomResult.success) return failure("expected expression after !", input);
  return success(
    {
      type: "binOpExpression" as const,
      operator: "!" as Operator,
      left: { type: "boolean" as const, value: true },
      right: atomResult.result,
    } as BinOpExpression,
    atomResult.rest,
  );
};

// --- Unary keyword operators (typeof, void) ---
// Same desugaring as !: typeof x → { op: "typeof", left: true, right: x }
function unaryKeywordParser(keyword: string): Parser<Expression> {
  return (input: string) => {
    const kwResult = str(keyword)(input);
    if (!kwResult.success) return kwResult;
    // Require word boundary (so "typeof" doesn't match inside "typeofFoo")
    if (!not(varNameChar)(kwResult.rest).success) {
      return failure(`expected whitespace after ${keyword}`, input);
    }
    const wsResult = spaces(kwResult.rest);
    if (!wsResult.success) return failure(`expected expression after ${keyword}`, input);
    const atomResult = atom(wsResult.rest);
    if (!atomResult.success) return failure(`expected expression after ${keyword}`, input);
    return success(
      {
        type: "binOpExpression" as const,
        operator: keyword as Operator,
        left: { type: "boolean" as const, value: true },
        right: atomResult.result,
      } as BinOpExpression,
      atomResult.rest,
    );
  };
}

const unaryTypeofParser = unaryKeywordParser("typeof");
const unaryVoidParser = unaryKeywordParser("void");

// Placeholder parser for `?` in pipe partial application
const placeholderParser: Parser<Placeholder> = (input: string) => {
  const result = char("?")(input);
  if (!result.success) return result;
  if (result.rest.length > 0 && /[a-zA-Z0-9_]/.test(result.rest[0])) {
    return failure("placeholder", input);
  }
  return success({ type: "placeholder" as const }, result.rest);
};

// --- try keyword ---
// Parses: try functionCall(args) or try obj.method(args)
const tryExpressionParser: Parser<TryExpression> =
  seqC(set("type", "tryExpression"), str("try"), spaces, capture(or(lazy(() => valueAccessParser), functionCallParser) as Parser<TryExpression["call"]>, "call"));

// Parses: new ClassName(args)
export const newExpressionParser: Parser<NewExpression> = (input: string) => {
  const parser = seqC(
    set("type", "newExpression"),
    str("new"),
    spaces,
    capture(many1WithJoin(varNameChar), "className"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(comma, lazy(() => exprParser)),
      "arguments",
    ),
    optionalSpaces,
    char(")"),
  );
  const result = parser(input);
  if (!result.success) return failure("expected 'new ClassName(args)'", input);
  return success(
    { type: "newExpression" as const, className: result.result.className, arguments: result.result.arguments },
    result.rest,
  );
};

// The base atom parser: the smallest unit of an expression.
export const schemaExpressionParser: Parser<SchemaExpression> = trace(
  "schemaExpressionParser",
  seqC(
    set("type", "schemaExpression"),
    str("schema"),
    char("("),
    optionalSpaces,
    capture(variableTypeParser, "typeArg"),
    optionalSpaces,
    char(")"),
  ),
);

const baseAtom: Parser<Expression> = or(
  unaryTypeofParser,
  unaryVoidParser,
  unaryNotParser,
  tryExpressionParser,
  newExpressionParser,
  schemaExpressionParser,
  placeholderParser,
  lazy(() => agencyArrayParser),
  lazy(() => agencyObjectParser),
  lazy(() => booleanParser),
  lazy(() => regexLiteralParser),
  lazy(() => valueAccessParser),
  lazy(() => literalParser),
);

// Wrap atom to handle postfix ++ and -- operators.
// Desugared to BinOpExpression: x++ → { op: "++", left: x, right: true }
const postfixOpParser = or(str("++"), str("--"));
const atom: Parser<Expression> = (input: string) => {
  const result = baseAtom(input);
  if (!result.success) return result;
  const ppResult = postfixOpParser(result.rest);
  if (!ppResult.success) return result;
  return success(
    {
      type: "binOpExpression" as const,
      operator: ppResult.result as Operator,
      left: result.result,
      right: { type: "boolean" as const, value: true },
    } as BinOpExpression,
    ppResult.rest,
  );
};

// Operator helper: parse an operator with optional surrounding whitespace.
// Allows a newline before the operator so expressions can continue on the next line:
//   let x = a
//     |> b
function wsOp(opStr: string): Parser<string> {
  return (input: string) => {
    const r1 = optionalSpacesOrNewline(input);
    if (!r1.success) return r1;
    const r2 = str(opStr)(r1.rest);
    if (!r2.success) return r2;
    const r3 = optionalSpaces(r2.rest);
    if (!r3.success) return r3;
    return { success: true as const, result: opStr, rest: r3.rest };
  };
}

// Like wsOp but with word boundary check (for keyword operators like "catch")
const wsKeyword = (kw: string): Parser<string> =>
  map(seqR(optionalSpacesOrNewline, str(kw), not(varNameChar), optionalSpaces), () => kw);

// Build a BinOpExpression AST node
function makeBinOp(op: string): (left: Expression, right: Expression) => Expression {
  return (left, right) => ({
    type: "binOpExpression" as const,
    operator: op as Operator,
    left,
    right,
  });
}

// Custom paren parser with whitespace handling.
// The default paren parser in buildExpressionParser does input[0] === "("
// with no whitespace skipping. This handles optional whitespace inside parens.
let _exprParser: Parser<Expression>;
const parenParser: Parser<Expression> = (input: string) => {
  const openResult = char("(")(input);
  if (!openResult.success) return openResult;
  const ws1 = optionalSpaces(openResult.rest);
  if (!ws1.success) return ws1;
  const exprResult = _exprParser(ws1.rest);
  if (!exprResult.success) return failure("expected expression inside parentheses", input);
  const ws2 = optionalSpaces(exprResult.rest);
  if (!ws2.success) return ws2;
  const closeResult = char(")")(ws2.rest);
  if (!closeResult.success) return failure("expected closing parenthesis", input);
  return success(exprResult.result, closeResult.rest);
};

// Operator table: highest precedence first.
// Multi-char operators must come before their single-char prefixes
// (e.g., *= before *, <= before <).
export const exprParser: Parser<Expression> = label("an expression", buildExpressionParser<Expression>(
  atom,
  [
    // Precedence 7: exponentiation
    [
      { op: wsOp("**"), assoc: "right" as const, apply: makeBinOp("**") },
    ],
    // Precedence 6: multiplicative (and *=, /=)
    [
      { op: wsOp("*="), assoc: "right" as const, apply: makeBinOp("*=") },
      { op: wsOp("/="), assoc: "right" as const, apply: makeBinOp("/=") },
      { op: wsOp("*"), assoc: "left" as const, apply: makeBinOp("*") },
      { op: wsOp("/"), assoc: "left" as const, apply: makeBinOp("/") },
      { op: wsOp("%"), assoc: "left" as const, apply: makeBinOp("%") },
    ],
    // Precedence 5: additive (and +=, -=)
    [
      { op: wsOp("+="), assoc: "right" as const, apply: makeBinOp("+=") },
      { op: wsOp("-="), assoc: "right" as const, apply: makeBinOp("-=") },
      { op: wsOp("+"), assoc: "left" as const, apply: makeBinOp("+") },
      { op: wsOp("-"), assoc: "left" as const, apply: makeBinOp("-") },
    ],
    // Precedence 4: relational
    [
      { op: wsKeyword("instanceof"), assoc: "left" as const, apply: makeBinOp("instanceof") },
      { op: wsKeyword("in"), assoc: "left" as const, apply: makeBinOp("in") },
      { op: wsOp("<="), assoc: "left" as const, apply: makeBinOp("<=") },
      { op: wsOp(">="), assoc: "left" as const, apply: makeBinOp(">=") },
      { op: wsOp("<"), assoc: "left" as const, apply: makeBinOp("<") },
      { op: wsOp(">"), assoc: "left" as const, apply: makeBinOp(">") },
    ],
    // Precedence 3: equality
    [
      { op: wsOp("==="), assoc: "left" as const, apply: makeBinOp("===") },
      { op: wsOp("!=="), assoc: "left" as const, apply: makeBinOp("!==") },
      { op: wsOp("=~"), assoc: "left" as const, apply: makeBinOp("=~") },
      { op: wsOp("=="), assoc: "left" as const, apply: makeBinOp("==") },
      { op: wsOp("!~"), assoc: "left" as const, apply: makeBinOp("!~") },
      { op: wsOp("!="), assoc: "left" as const, apply: makeBinOp("!=") },
    ],
    // Precedence 2: logical AND
    [
      { op: wsOp("&&="), assoc: "right" as const, apply: makeBinOp("&&=") },
      { op: wsOp("&&"), assoc: "left" as const, apply: makeBinOp("&&") },
    ],
    // Precedence 1: logical OR, nullish coalescing
    [
      { op: wsOp("??="), assoc: "right" as const, apply: makeBinOp("??=") },
      { op: wsOp("??"), assoc: "left" as const, apply: makeBinOp("??") },
      { op: wsOp("||="), assoc: "right" as const, apply: makeBinOp("||=") },
      { op: wsOp("||"), assoc: "left" as const, apply: makeBinOp("||") },
    ],
    // Precedence 0: catch (unwrap Result with fallback)
    [
      { op: wsKeyword("catch"), assoc: "left" as const, apply: makeBinOp("catch") },
    ],
    // Precedence -1 (lowest): pipe
    [
      { op: wsOp("|>"), assoc: "left" as const, apply: makeBinOp("|>") },
    ],
  ],
  parenParser,
));

// Wire up the circular reference for parenParser
_exprParser = exprParser;

export const returnStatementParser: Parser<ReturnStatement> = label("a return statement", withLoc(seqC(
  set("type", "returnStatement"),
  str("return"),
  not(varNameChar),
  optional(
    captureCaptures(
      seqC(
        optionalSpaces,
        capture(exprParser, "value"),
      ),
    ),
  ),
  optionalSpaces,
  optionalSemicolon,
  optionalSpacesOrNewline,
)));

export const gotoStatementParser: Parser<GotoStatement> = label("a goto statement", withLoc(seqC(
  set("type", "gotoStatement"),
  str("goto"),
  not(varNameChar),
  optionalSpaces,
  capture(functionCallParser, "nodeCall"),
  optionalSpaces,
  optionalSemicolon,
  optionalSpacesOrNewline,
)));

// =============================================================================
// binop.ts
// =============================================================================

// binOpParser now delegates to the unified expression parser.
// It only succeeds if the result is a BinOpExpression (not just an atom),
// preserving the original behavior for callers like bodyParser and agencyNode
// that list binOpParser as one of many alternatives.
export const binOpParser: Parser<BinOpExpression> = (input: string) => {
  const result = exprParser(input);
  if (!result.success) return result;

  if (result.result.type !== "binOpExpression") {
    return failure("expected binary expression", input);
  }

  // Consume optional trailing semicolon
  const semiResult = optionalSemicolon(result.rest);
  const finalRest = semiResult.success ? semiResult.rest : result.rest;
  return success(result.result as BinOpExpression, finalRest);
};

// =============================================================================
// blockArgument.ts
// =============================================================================

// Parse a single block parameter (just a name, no type annotation — types come from the function signature)
const blockParamParser: Parser<FunctionParameter> = trace(
  "blockParamParser",
  seqC(
    set("type", "functionParameter"),
    capture(many1WithJoin(varNameChar), "name"),
  ),
);

// Parse block parameters after "as":
//   as item { ... }           — single param
//   as (prev, attempt) { ... } — multiple params
//   as { ... }                — no params
const blockParamsParser: Parser<FunctionParameter[]> = (input: string): ParserResult<FunctionParameter[]> => {
  // Try multiple params: (a, b, c)
  const multiParser = seqC(
    char("("),
    optionalSpaces,
    capture(sepBy(comma, blockParamParser), "params"),
    optionalSpaces,
    char(")"),
  );
  const multiResult = multiParser(input);
  if (multiResult.success) {
    return success(multiResult.result.params, multiResult.rest);
  }

  // Try single param: identifier (but not "{" which means no params)
  const singleResult = blockParamParser(input);
  if (singleResult.success) {
    return success([singleResult.result], singleResult.rest);
  }

  // No params — return empty array
  return success([], input);
};

// Parse a block argument. Always requires "as" keyword:
//   as params { body }     — with params
//   as { body }            — no params
export const blockArgumentParser: Parser<BlockArgument> = trace(
  "blockArgumentParser",
  seqC(
    set("type", "blockArgument"),
    set("inline", false),
    str("as"),
    spaces,
    capture(blockParamsParser, "params"),
    optionalSpaces,
    char("{"),
    optionalSpacesOrNewline,
    capture(lazy(() => bodyParser), "body"),
    optionalSpacesOrNewline,
    char("}"),
  ),
);

// Parse an inline block argument: \params -> expression
//   \x -> x + 1           — single param
//   \(x, i) -> x + i      — multiple params
//   \ -> "hello"           — no params
// Expression-only: the expression is wrapped in a synthetic return statement.
export const inlineBlockParser: Parser<BlockArgument> = trace(
  "inlineBlockParser",
  map(
    seqC(
      char("\\"),
      optionalSpaces,
      capture(blockParamsParser, "params"),
      optionalSpaces,
      str("->"),
      optionalSpaces,
      capture(lazy(() => exprParser), "expr"),
    ),
    (result) => ({
      type: "blockArgument" as const,
      inline: true,
      params: result.params,
      body: [{ type: "returnStatement", value: result.expr } as ReturnStatement],
    }),
  ),
);

// =============================================================================
// matchBlock.ts
// =============================================================================

export const defaultCaseParser: Parser<DefaultCase> = char("_");

export const matchBlockParserCase: Parser<MatchBlockCase> = (
  input: string,
): ParserResult<MatchBlockCase> => {
  const parser = seqC(
    set("type", "matchBlockCase"),
    optionalSpaces,
    capture(or(defaultCaseParser, exprParser), "caseValue"),
    optionalSpaces,
    str("=>"),
    optionalSpaces,
    capture(or(returnStatementParser, lazy(() => assignmentParser), exprParser), "body"),
    optionalSemicolon,
    optionalSpacesOrNewline,
  );
  return parser(input);
};

const semicolon = seqC(optionalSpaces, char(";"), optionalSpaces);

export const matchBlockParser = label("a match block", withLoc(seqC(
  set("type", "matchBlock"),
  str("match"),
  optionalSpaces,
  char("("),
  capture(exprParser, "expression"),
  char(")"),
  optionalSpaces,
  char("{"),
  captureCaptures(
    parseError(
      "expected match cases of the form `value => expression` separated by `;` or newlines, followed by `}`",
      optionalSpacesOrNewline,
      capture(many(or(commentParser, matchBlockParserCase)), "cases"),
      optionalSpaces,
      char("}"),
    ),
  ),
  optionalSemicolon,
  optionalSpacesOrNewline,
)));

// =============================================================================
// importStatement.ts
// =============================================================================

// Helper parser for quoted file paths - supports both single and double quotes
const doubleQuotedPath: Parser<{ path: string }> = seqC(
  char('"'),
  capture(many1Till(char('"')), "path"),
  char('"'),
);

const singleQuotedPath: Parser<{ path: string }> = seqC(
  char("'"),
  capture(many1Till(char("'")), "path"),
  char("'"),
);

const quotedPath: Parser<string> = map(
  or(doubleQuotedPath, singleQuotedPath),
  (res) => res.path,
);

export const importNodeStatmentParser: Parser<ImportNodeStatement> = trace(
  "importNodeStatement",
  seqC(
    set("type", "importNodeStatement"),
    str("import"),
    spaces,
    or(str("nodes"), str("node")),
    captureCaptures(
      parseError(
        "expected a statement of the form `import nodes { x, y } from 'filename.agency'`",
        spaces,
        char("{"),
        optionalSpaces,
        capture(sepBy1(comma, many1WithJoin(varNameChar)), "importedNodes"),
        optionalSpaces,
        char("}"),
        spaces,
        str("from"),
        spaces,
        capture(quotedPath, "agencyFile"),
        optionalSemicolon,
        optional(newline),
      ),
    ),
  ),
);

const nameWithOptionalAlias = or(
  map(
    seqC(capture(many1WithJoin(varNameChar), "name"), spaces, str("as"), spaces, capture(many1WithJoin(varNameChar), "alias")),
    (r) => ({ name: r.name, alias: r.alias as string }),
  ),
  map(
    seqC(capture(many1WithJoin(varNameChar), "name")),
    (r) => ({ name: r.name, alias: undefined as string | undefined }),
  ),
);

const safeNameItem = or(
  map(
    seqC(str("safe "), captureCaptures(nameWithOptionalAlias)),
    (r) => ({
      name: r.name,
      alias: r.alias as string | undefined,
      isSafe: true,
    }),
  ),
  map(
    nameWithOptionalAlias,
    (r) => ({
      name: r.name,
      alias: r.alias,
      isSafe: false,
    }),
  ),
);


const namedImportParser: Parser<NamedImport> = trace(
  "namedImportParser",
  map(
    seqC(
      char("{"),
      optionalSpaces,
      capture(sepBy1(comma, safeNameItem), "items"),
      optionalSpaces,
      char("}"),
    ),
    (result) => {
      const importedNames: string[] = [];
      const safeNames: string[] = [];
      const aliases: Record<string, string> = {};
      for (const item of result.items) {
        importedNames.push(item.name);
        if (item.alias) {
          aliases[item.name] = item.alias;
        }
        if (item.isSafe) {
          safeNames.push(item.name);
        }
      }
      return { type: "namedImport" as const, importedNames, safeNames, aliases };
    },
  ),
);

const namespaceImportParser: Parser<NamespaceImport> = trace(
  "namespaceImportParser",
  seqC(
    many1Till(spaces),
    spaces,
    str("as"),
    spaces,
    capture(many1WithJoin(varNameChar), "importedNames"),
    set("type", "namespaceImport"),
  ),
);

const defaultImportParser: Parser<DefaultImport> = trace(
  "defaultImportParser",
  seqC(
    capture(many1WithJoin(varNameChar), "importedNames"),
    set("type", "defaultImport"),
  ),
);

const importNameTypeParser: Parser<ImportNameType[]> = sepBy(
  comma,
  or(namedImportParser, namespaceImportParser, defaultImportParser),
);

export const importStatmentParser: Parser<ImportStatement> = map(
  trace(
    "importStatement",
    seqC(
      set("type", "importStatement"),
      str("import"),
      captureCaptures(
        parseError(
          "expected a statement of the form `import { x, y } from 'filename'`",
          spaces,
          capture(importNameTypeParser, "importedNames"),
          spaces,
          str("from"),
          spaces,
          oneOf(`'"`),
          capture(many1Till(oneOf(`'"`)), "modulePath"),
          oneOf(`'"`),
          optionalSemicolon,
          optional(newline),
        ),
      ),
    ),
  ),
  (result) => ({ ...result, isAgencyImport: isAgencyImport(result.modulePath) }),
);

// =============================================================================
// function.ts (the big one — assignment, body, nodes, functions, loops, etc.)
// =============================================================================

const _assignmentParserInner: Parser<Assignment> = (input: string) => {
  const parser = trace(
    "assignmentParser",
    seqC(
      set("type", "assignment"),
      optionalSpaces,
      optional(
        captureCaptures(
          seqC(
            capture(or(str("let"), str("const")), "declKind"),
            spaces,
          ),
        ),
      ),
      capture(_valueAccessParser, "target"),
      optionalSpaces,
      optional(
        captureCaptures(
          seqC(
            char(":"),
            optionalSpaces,
            capture(variableTypeParser, "typeHint"),
            capture(optional(map(str("!"), () => true)), "validated"),
          ),
        ),
      ),
      optionalSpaces,
      char("="),
      optionalSpaces,
      capture(or(lazy(() => messageThreadParser), exprParser), "value"),
      optionalSemicolon,
      optionalSpacesOrNewline,
    ),
  );
  const result = parser(input);
  if (!result.success) return result;

  const target = result.result.target;
  let variableName: string;
  let accessChain: AccessChainElement[] | undefined;

  if (target.type === "variableName") {
    variableName = target.value;
  } else if (target.type === "valueAccess") {
    if (target.base.type !== "variableName") {
      return failure(
        "assignment target must start with a variable name",
        input,
      );
    }
    variableName = target.base.value;
    accessChain = target.chain;
  } else {
    return failure("invalid assignment target", input);
  }

  const parsed = result.result as any;

  // Reject let/const with access chains (e.g., "let obj.x = 1")
  if (parsed.declKind && accessChain) {
    return failure(
      "cannot use 'let' or 'const' with property/index assignment",
      input,
    );
  }

  const { target: _target, validated: _validated, value, ...rest } = parsed;
  const out: Assignment = { ...rest, variableName, value, accessChain };
  if (_validated) out.validated = true;
  return success(out, result.rest);
};
export const assignmentParser: Parser<Assignment> = label("an assignment", withLoc(_assignmentParserInner));

export const staticAssignmentParser: Parser<Assignment> = (input: string) => {
  const parser = seqC(str("static"), spaces, captureCaptures(assignmentParser));
  const result = parser(input);
  if (!result.success) return result;
  if (result.result.declKind !== "const") {
    return failure("static requires 'const' (e.g., 'static const x = 1'). Static variables are immutable.", input);
  }
  return success({ ...result.result, static: true }, result.rest);
};

const trim = (s: string) => s.trim();
export const docStringParser: Parser<DocString> = trace(
  "docStringParser",
  seqC(
    set("type", "docString"),
    str('"""'),
    capture(map(many1Till(str('"""')), trim), "value"),
    str('"""'),
  ),
);

export const bodyParser = (input: string): ParserResult<AgencyNode[]> => {
  const bodyNodeParser = or(
    keywordParser,
    debug(typeAliasParser, "error in typeAliasParser"),
    tagParser,
    returnStatementParser,
    gotoStatementParser,
    forLoopParser,
    whileLoopParser,
    parallelBlockParser,
    seqBlockParser,
    matchBlockParser,
    ifParser,
    messageThreadParser,
    handleBlockParser,
    debuggerParser,
    multiLineCommentParser,
    commentParser,
    skillParser,
    withModifierParser,
    assignmentParser,
    binOpParser,
    booleanParser,
    valueAccessParser,
    literalParser,
    newLineParser,
  );
  const parser = trace(
    "functionBodyParser",
    many(
      map(
        seqC(capture(bodyNodeParser, "node"), optionalSpacesOrNewline),
        (result) => result.node,
      ),
    ),
  );
  return parser(input);
};

export const _messageThreadParser: Parser<MessageThread> = trace(
  "_messageThreadParser",
  seqC(
    set("type", "messageThread"),
    str("thread"),
    set("threadType", "thread"),
    optionalSpaces,
    char("{"),
    captureCaptures(
      parseError(
        "expected block body followed by `}`",
        spaces,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  ),
);
export const _submessageThreadParser: Parser<MessageThread> = trace(
  "_submessageThreadParser",
  seqC(
    set("type", "messageThread"),
    str("subthread"),
    set("threadType", "subthread"),
    optionalSpaces,
    char("{"),
    captureCaptures(
      parseError(
        "expected block body followed by `}`",
        spaces,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  ),
);
export const messageThreadParser: Parser<MessageThread> = withLoc(or(
  _messageThreadParser,
  _submessageThreadParser,
));

const inlineHandlerParser: Parser<HandleBlock["handler"]> = (input) => {
  const parser = seqC(
    set("kind", "inline"),
    char("("),
    optionalSpaces,
    capture(lazy(() => functionParameterParser), "param"),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open handler body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  );
  return parser(input);
};

const functionRefHandlerParser: Parser<HandleBlock["handler"]> = (input) => {
  const parser = seqC(
    set("kind", "functionRef"),
    capture(many1WithJoin(varNameChar), "functionName"),
    optionalSpacesOrNewline,
  );
  return parser(input);
};

export const handleBlockParser: Parser<HandleBlock> = withLoc(trace(
  "handleBlockParser",
  seqC(
    set("type", "handleBlock"),
    str("handle"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open handle block body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
      ),
    ),
    optionalSpacesOrNewline,
    str("with"),
    optionalSpaces,
    capture(or(inlineHandlerParser, functionRefHandlerParser), "handler"),
  ),
));

export const withModifierParser: Parser<WithModifier> = withLoc((input: string) => {
  // Try to parse a static assignment, regular assignment, or bare function call as the inner statement.
  const stmtResult = or(staticAssignmentParser, assignmentParser, functionCallParser)(input);
  if (!stmtResult.success) return failure("expected statement before 'with'", input);

  // Look for "with <builtin>" on remaining input.
  // assignmentParser consumes trailing whitespace, so rest starts at "with...".
  // functionCallParser does NOT consume trailing whitespace, so we need optionalSpaces first.
  const modParser = seqC(
    optionalSpaces,
    str("with"),
    spaces,
    capture(or(str("approve"), str("reject"), str("propagate")), "handlerName"),
    optionalSpacesOrNewline,
  );
  const modResult = modParser(stmtResult.rest);
  if (!modResult.success) return failure("expected 'with approve/reject/propagate'", input);

  return success(
    {
      type: "withModifier" as const,
      statement: stmtResult.result,
      handlerName: modResult.result.handlerName as WithModifier["handlerName"],
    },
    modResult.rest,
  );
});

const elseClauseParser: Parser<AgencyNode[]> = (input: string) => {
  const parser = seqC(optionalSpaces, str("else"), optionalSpaces);
  const prefixResult = parser(input);
  if (!prefixResult.success) return prefixResult;

  // Try parsing "else if" (another ifParser)
  const elseIfResult = ifParser(prefixResult.rest);
  if (elseIfResult.success) {
    return success([elseIfResult.result], elseIfResult.rest);
  }

  // Otherwise parse "else { body }"
  const elseBlockParser = seqC(
    char("{"),
    optionalSpacesOrNewline,
    capture(bodyParser, "body"),
    optionalSpacesOrNewline,
    char("}"),
    optionalSpacesOrNewline,
  );
  const blockResult = elseBlockParser(prefixResult.rest);
  if (!blockResult.success) return blockResult;
  return success(blockResult.result.body, blockResult.rest);
};

const _ifParserInner: Parser<IfElse> = (input: string) => {
  const parser = trace(
    "ifParser",
    seqC(
      set("type", "ifElse"),
      str("if"),
      optionalSpaces,
      char("("),
      optionalSpaces,
      capture(exprParser, "condition"),
      optionalSpaces,
      char(")"),
      optionalSpaces,
      captureCaptures(
        parseError(
          "expected `{` to open if block body",
          char("{"),
          optionalSpacesOrNewline,
          capture(bodyParser, "thenBody"),
          optionalSpacesOrNewline,
          char("}"),
          optionalSpacesOrNewline,
        ),
      ),
    ),
  );
  const result = parser(input);
  if (!result.success) return result;

  // Try to parse an optional else clause
  const elseResult = elseClauseParser(result.rest);
  if (elseResult.success) {
    return success(
      { ...result.result, elseBody: elseResult.result },
      elseResult.rest,
    );
  }

  return result;
};
export const ifParser: Parser<IfElse> = label("an if statement", withLoc(_ifParserInner));

export const whileLoopParser: Parser<WhileLoop> = label("a while loop", withLoc(trace(
  "whileLoopParser",
  seqC(
    set("type", "whileLoop"),
    str("while"),
    optionalSpaces,
    char("("),
    optionalSpaces,
    capture(exprParser, "condition"),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open while loop body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  ),
)));

export const parallelBlockParser: Parser<ParallelBlock> = label("a parallel block", withLoc(trace(
  "parallelBlockParser",
  seqC(
    set("type", "parallelBlock"),
    str("parallel"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open parallel block body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
      ),
    ),
  ),
)));

export const seqBlockParser: Parser<SeqBlock> = label("a seq block", withLoc(trace(
  "seqBlockParser",
  seqC(
    set("type", "seqBlock"),
    str("seq"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open seq block body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
      ),
    ),
  ),
)));

export const forLoopParser: Parser<ForLoop> = label("a for loop", withLoc(trace(
  "forLoopParser",
  seqC(
    set("type", "forLoop"),
    str("for"),
    optionalSpaces,
    char("("),
    optionalSpaces,
    optional(or(str("let"), str("const"))),
    optionalSpaces,
    capture(many1WithJoin(varNameChar), "itemVar"),
    optional(
      captureCaptures(
        seqC(
          optionalSpaces,
          char(","),
          optionalSpaces,
          capture(many1WithJoin(varNameChar), "indexVar"),
        ),
      ),
    ),
    optionalSpaces,
    or(str("in"), str("of")),
    spaces,
    capture(exprParser, "iterable"),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open for loop body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  ),
)));

// Parses: name, name?, name: type, name?: type, name = default, name? = default, name: type = default
export const functionParameterParser: Parser<FunctionParameter> = trace(
  "functionParameterParser",
  map(
    seqC(
      set("type", "functionParameter"),
      capture(many1WithJoin(varNameChar), "name"),
      capture(optional(char("?")), "__optional"),
      optional(
        captureCaptures(
          seqC(
            optionalSpaces,
            char(":"),
            optionalSpaces,
            capture(variableTypeParser, "typeHint"),
            capture(optional(map(str("!"), () => true)), "validated"),
          ),
        ),
      ),
      optional(
        captureCaptures(
          seqC(
            optionalSpaces,
            str("="),
            optionalSpaces,
            capture(or(agencyArrayParser, agencyObjectParser, literalParserNoVarName), "defaultValue"),
          ),
        ),
      ),
    ),
    (result: any) => {
      const { __optional, validated: _validated, ...rest } = result;
      if (__optional && !rest.defaultValue) {
        rest.defaultValue = { type: "null" };
      }
      if (_validated) rest.validated = true;
      return rest as FunctionParameter;
    },
  ),
);

// Parses: ...name, ...name: type
export const variadicParameterParser: Parser<FunctionParameter> = trace(
  "variadicParameterParser",
  map(
    seqC(
      set("type", "functionParameter"),
      str("..."),
      capture(many1WithJoin(varNameChar), "name"),
      optional(
        captureCaptures(
          seqC(
            optionalSpaces,
            char(":"),
            optionalSpaces,
            capture(variableTypeParser, "typeHint"),
          ),
        ),
      ),
    ),
    (result) => ({ ...result, variadic: true }),
  ),
);

export const functionReturnTypeParser: Parser<VariableType> = trace(
  "functionReturnTypeParser",
  seqC(
    char(":"),
    optionalSpaces,
    captureCaptures(
      or(variableTypeParser, parseError("Invalid return type", fail("error"))),
    ),
  ),
);

const _baseFunctionParser: Parser<any> = trace(
  "_baseFunctionParser",
  seqC(
    set("type", "function"),
    capture(or(str("callback"), str("def")), "keyword"),
    many1(space),
    capture(many1Till(char("(")), "functionName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        or(variadicParameterParser, functionParameterParser),
      ),
      "parameters",
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    capture(optional(functionReturnTypeParser), "returnType"),
    capture(optional(map(str("!"), () => true)), "returnTypeValidated"),
    captureCaptures(
      parseError(
        "Expected function body",
        optionalSpacesOrNewline,
        char("{"),
        optionalSpacesOrNewline,
        capture(or(docStringParser, succeed(undefined)), "docString"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSemicolon,
      ),
    ),
  ),
);

const exportKeywordParser: Parser<boolean> = or(
  map(seqC(str("export"), spaces), () => true),
  succeed(false),
);

const safeKeywordParser: Parser<boolean> = or(
  map(seqC(str("safe"), spaces), () => true),
  succeed(false),
);

const _functionParserInner: Parser<FunctionDefinition> = (input: string) => {
  const exportResult = exportKeywordParser(input);
  if (!exportResult.success) return exportResult;
  const isExported = exportResult.result;

  const safeResult = safeKeywordParser(exportResult.rest);
  if (!safeResult.success) return safeResult;
  const isSafe = safeResult.result;

  const baseResult = _baseFunctionParser(safeResult.rest);
  if (!baseResult.success) return baseResult;

  const { keyword, returnTypeValidated: _rtv, ...rest } = baseResult.result as any;
  const result = { ...rest } as FunctionDefinition;
  if (_rtv) result.returnTypeValidated = true;
  const isCallback = keyword === "callback";
  if (isExported) result.exported = true;
  if (isSafe) result.safe = true;
  if (isCallback) {
    result.callback = true;
    if (isExported) {
      throw new Error(`Callback '${result.functionName}' cannot be exported`);
    }
    if (isSafe) {
      throw new Error(`Callback '${result.functionName}' cannot be marked safe`);
    }
    const validNames: ReadonlySet<string> = new Set(VALID_CALLBACK_NAMES);
    if (!validNames.has(result.functionName)) {
      throw new Error(
        `Unknown callback '${result.functionName}'. Valid callbacks: ${VALID_CALLBACK_NAMES.join(", ")}`,
      );
    }
    if (result.parameters.length !== 1) {
      throw new Error(
        `Callback '${result.functionName}' must declare exactly one parameter`,
      );
    }
    if (result.parameters[0].variadic) {
      throw new Error(
        `Callback '${result.functionName}' parameter '${result.parameters[0].name}' cannot be variadic`,
      );
    }
    if (result.parameters[0].defaultValue) {
      throw new Error(
        `Callback '${result.functionName}' parameter '${result.parameters[0].name}' cannot have a default value`,
      );
    }
  }

  // Validate parameter ordering: required → optional (with defaults) → variadic
  const params = result.parameters;
  let seenOptional = false;
  for (let i = 0; i < params.length; i++) {
    if (params[i].variadic) {
      if (i !== params.length - 1) {
        return failure(
          `Variadic parameter '${params[i].name}' must be the last parameter`,
          input,
        );
      }
    } else if (params[i].defaultValue) {
      seenOptional = true;
    } else if (seenOptional) {
      return failure(
        `Required parameter '${params[i].name}' cannot follow optional parameter`,
        input,
      );
    }
  }

  return { ...baseResult, result };
};
export const functionParser: Parser<FunctionDefinition> = label("a function definition", withLoc(_functionParserInner));

const visibilityParser: Parser<Visibility> = or(
  str("public" as const),
  str("private" as const),
  succeed(undefined),
);

export const graphNodeParser: Parser<GraphNodeDefinition> = label("a node definition", withLoc(trace(
  "graphNodeParser",
  map(
    seqC(
      set("type", "graphNode"),
      capture(visibilityParser, "visibility"),
      optionalSpaces,
      str("node"),
      many1(space),
      capture(many1Till(char("(")), "nodeName"),
      char("("),
      optionalSpaces,
      capture(
        sepBy(
          comma,
          functionParameterParser,
        ),
        "parameters",
      ),
      optionalSpaces,
      char(")"),
      optionalSpaces,
      capture(optional(functionReturnTypeParser), "returnType"),
      capture(optional(map(str("!"), () => true)), "returnTypeValidated"),
      captureCaptures(
        parseError(
          "expected node body",
          optionalSpacesOrNewline,
          char("{"),
          optionalSpacesOrNewline,
          capture(or(docStringParser, succeed(undefined)), "docString"),
          optionalSpacesOrNewline,
          capture(bodyParser, "body"),
          optionalSpacesOrNewline,
          char("}"),
          optionalSemicolon,
        ),
      ),
    ),
    (result: any) => {
      const { returnTypeValidated: _rtv, ...rest } = result;
      if (_rtv) rest.returnTypeValidated = true;
      return rest;
    },
  ),
)));

// =============================================================================
// classDefinition parser
// =============================================================================

// Parses: name: type
const classFieldParser: Parser<ClassField> = (input: string) => {
  const parser = seqC(
    set("type", "classField"),
    capture(many1WithJoin(varNameChar), "name"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(variableTypeParser, "typeHint"),
    optionalSemicolon,
    optionalSpacesOrNewline,
  );
  return parser(input);
};

// Detects constructor keyword and returns an error — constructors are auto-generated
const rejectConstructorParser: Parser<never> = (input: string) => {
  const result = str("constructor")(input);
  if (result.success) {
    return failure("custom constructors are not supported — constructors are auto-generated from field declarations", input);
  }
  return failure("", input);
};

// Parses: name(params): returnType { body }
const classMethodParser: Parser<ClassMethod> = map(
  seqC(
    set("type", "classMethod"),
    capture(safeKeywordParser, "safe"),
    capture(many1WithJoin(varNameChar), "name"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(comma, or(variadicParameterParser, functionParameterParser)),
      "parameters",
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(variableTypeParser, "returnType"),
    optionalSpacesOrNewline,
    char("{"),
    optionalSpacesOrNewline,
    capture(bodyParser, "body"),
    optionalSpacesOrNewline,
    char("}"),
    optionalSpacesOrNewline,
  ),
  (result) => {
    const method = result as ClassMethod;
    if (!method.safe) delete method.safe;
    return method;
  },
);

// Class body member: field, constructor, or method.
// Fields are tried first (name: type), then constructor, then methods (name(...): type { ... }).
// To distinguish fields from methods, we use a lookahead: if we see `name(`, it's a method.
const classBodyMemberParser = or(
  rejectConstructorParser,
  classMethodParser,
  classFieldParser,
);

const _classParserInner: Parser<ClassDefinition> = (input: string) => {
  const parser = seqC(
    str("class"),
    spaces,
    capture(many1WithJoin(varNameChar), "className"),
    optionalSpaces,
    capture(
      optional(
        seqC(
          str("extends"),
          spaces,
          captureCaptures(
            seqC(capture(many1WithJoin(varNameChar), "parentClass")),
          ),
          optionalSpaces,
        ),
      ),
      "_extends",
    ),
    char("{"),
    optionalSpacesOrNewline,
    capture(many(classBodyMemberParser), "members"),
    optionalSpacesOrNewline,
    char("}"),
    optionalSpacesOrNewline,
  );

  const result = parser(input);
  if (!result.success) return failure("expected class definition", input);

  // Separate fields and methods
  const fields: ClassField[] = [];
  const methods: ClassMethod[] = [];

  for (const member of result.result.members) {
    if (member.type === "classField") {
      fields.push(member);
    } else if (member.type === "classMethod") {
      methods.push(member);
    }
  }

  const parentClass = result.result._extends?.parentClass;
  const def: ClassDefinition = {
    type: "classDefinition",
    className: result.result.className,
    fields,
    methods,
    ...(parentClass ? { parentClass } : {}),
  };

  return success(def, result.rest);
};

export const classParser: Parser<ClassDefinition> = label("a class definition", withLoc(_classParserInner));
