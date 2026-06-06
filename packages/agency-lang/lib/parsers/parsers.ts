/* eslint-disable max-lines -- intentionally combined into one file to eliminate circular dependencies */
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
  istr,
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
  memo,
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
  Expression,
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
  InterpolationSegment,
  Literal,
  MultiLineStringLiteral,
  NamedArgument,
  NewLine,
  NullLiteral,
  NumberLiteral,
  UnitLiteral,
  TimeUnitLiteral,
  ByteUnitLiteral,
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
  ObjectTypeTrivia,
  GenericType,
  PrimitiveType,
  ResultType,
  StringLiteralType,
  TypeAlias,
  TypeAliasVariable,
  TypeParam,
  UnionType,
  Tag,
  ValueParam,
} from "../types.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { ForLoop } from "../types/forLoop.js";
import { WhileLoop } from "../types/whileLoop.js";
import { ParallelBlock, SeqBlock } from "../types/parallelBlock.js";
import { IfElse } from "../types/ifElse.js";
import { ValueAccess } from "../types/access.js";
import { BlockArgument } from "../types/blockArgument.js";
import { BinOpExpression, Operator } from "../types/binop.js";
import { TryExpression } from "../types/tryExpression.js";
import { NewExpression } from "../types/newExpression.js";
import { SchemaExpression } from "../types/schemaExpression.js";
import { InterruptStatement } from "../types/interruptStatement.js";
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
import { ExportFromStatement } from "../types/exportFromStatement.js";
import { DefaultCase, MatchBlockCase } from "../types/matchBlock.js";
import { MessageThread } from "@/types/messageThread.js";
import { HandleBlock } from "@/types/handleBlock.js";
import { WithModifier } from "@/types/withModifier.js";
import { StaticStatement } from "@/types/staticStatement.js";
import {
  ArrayPattern,
  BindingPattern,
  IsExpression,
  MatchPattern,
  ObjectPattern,
  ObjectPatternProperty,
  ObjectPatternShorthand,
  RestPattern,
  ResultPattern,
  WildcardPattern,
} from "../types/pattern.js";

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
parseAgency sets the per-parse offset (AGENCY_TEMPLATE_OFFSET when the template
wrapper was applied, else 0) so loc.line is always 0-indexed in the user's
source regardless of parse mode.
*/
export const AGENCY_TEMPLATE_OFFSET = 2;

let currentTemplateOffset = 0;

export function setTemplateOffset(n: number): void {
  currentTemplateOffset = n;
}

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
      line: span.start.line - currentTemplateOffset,
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

export const BLANK_LINE_SENTINEL = "\uE000";

export const stripSentinels = (s: string) => s.replaceAll(BLANK_LINE_SENTINEL, "\n");

export const blankLineParser: Parser<NewLine> = map(
  many1(char(BLANK_LINE_SENTINEL)),
  () => ({ type: "newLine" as const }),
);

// =============================================================================
// comment.ts
// =============================================================================

export const commentParser: Parser<AgencyComment> = (input: string) => {
  const parser = seqC(
    set("type", "comment"),
    optionalSpaces,
    str("//"),
    capture(manyTill(or(newline, blankLineParser)), "content"),
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
    set("isModuleDoc", false as boolean),
    optionalSpaces,
    capture(map(between(str("/*"), str("*/"), anyChar), joinChars), "content"),
  );
  const result = parser(input);
  if (result.success) {
    result.result.content = stripSentinels(result.result.content);
    if (result.result.content.startsWith("*")) {
      result.result.isDoc = true;
      result.result.content = result.result.content.slice(1);
      // Detect /** @module ... */ syntax for file-level doc comments
      const trimmed = result.result.content.trimStart();
      if (trimmed.startsWith("@module")) {
        result.result.isModuleDoc = true;
        // Strip the @module tag from content
        result.result.content = trimmed.slice("@module".length);
      }
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

// Delimiter-aware text segment: stops only on the matching closing quote
// (the one that opened the string) or `${`. Lets the *other two* quote
// characters appear unescaped inside — e.g. a double-quoted string can
// contain backticks and single quotes, and so on.
//
// Supports the following backslash escapes:
//   \\ → \    \n → newline   \t → tab    \r → carriage return
//   \" → "    \' → '         \` → `      \0 → null
//   \${ → ${ (the only `\$` escape — writes a literal `${` without
//   starting interpolation; bare `\$` is preserved verbatim so existing
//   strings like regex patterns are not silently changed).
//
// An unrecognized escape (`\x`, where `x` isn't in the list above) is
// preserved verbatim — both the backslash and the character — so existing
// strings containing literal `\` followed by non-escape characters are
// unaffected. This is the same behavior as Python's regular strings.
const stringTextSegmentParserFor = (delim: '"' | "'" | "`"): Parser<TextSegment> =>
  (input: string): ParserResult<TextSegment> => {
    let i = 0;
    let value = "";
    while (i < input.length) {
      const c = input[i];
      if (c === delim) break;
      if (c === "$" && input[i + 1] === "{") break;
      if (c === "\\" && i + 1 < input.length) {
        const next = input[i + 1];
        // `\${` is the only `\$` escape we recognize; bare `\$` falls
        // through to "unknown escape → preserved verbatim" so existing
        // strings with literal `\$` (e.g. regex source) keep working.
        if (next === "$" && input[i + 2] === "{") {
          value += "${";
          i += 3;
          continue;
        }
        switch (next) {
          case "\\": value += "\\"; break;
          case '"':  value += '"';  break;
          case "'":  value += "'";  break;
          case "`":  value += "`";  break;
          case "n":  value += "\n"; break;
          case "t":  value += "\t"; break;
          case "r":  value += "\r"; break;
          case "0":  value += "\0"; break;
          default:   value += "\\" + next; break;
        }
        i += 2;
        continue;
      }
      value += c;
      i++;
    }
    if (i === 0) return failure("expected string text", input);
    return success({ type: "text" as const, value }, input.slice(i));
  };

export const multiLineStringTextSegmentParser: Parser<TextSegment> = map(
  many1Till(or(str('"""'), str("${"))),
  (text) => ({
    type: "text",
    value: text,
  }),
);

export const interpolationSegmentParser: Parser<InterpolationSegment> = withLoc((
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
});

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

// --- Unit literal parser ---
const TIME_MULTIPLIERS: Record<TimeUnitLiteral["unit"], number> = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  w: 604800000,
};

const unsignedNumberChars = many1WithJoin(or(char("."), digit));
const timeSuffix = or(str("ms"), str("s"), str("m"), str("h"), str("d"), str("w"));

const timeUnitParser: Parser<UnitLiteral> = label("a time unit literal", (input: string): ParserResult<UnitLiteral> => {
  const parser = seqC(
    set("type", "unitLiteral"),
    set("dimension", "time"),
    capture(unsignedNumberChars, "value"),
    capture(timeSuffix, "unit"),
  );
  const result = parser(input);
  if (!result.success) return result;
  const { value, unit } = result.result;
  return success({
    ...result.result,
    canonicalValue: Math.round(parseFloat(value) * TIME_MULTIPLIERS[unit as TimeUnitLiteral["unit"]]),
  } as UnitLiteral, result.rest);
});

const costUnitParser: Parser<UnitLiteral> = label("a cost unit literal", (input: string): ParserResult<UnitLiteral> => {
  const parser = seqC(
    set("type", "unitLiteral"),
    set("dimension", "cost"),
    set("unit", "$"),
    char("$"),
    capture(unsignedNumberChars, "value"),
  );
  const result = parser(input);
  if (!result.success) return result;
  return success({
    ...result.result,
    canonicalValue: parseFloat(result.result.value),
  } as UnitLiteral, result.rest);
});

const BYTE_MULTIPLIERS: Record<ByteUnitLiteral["unit"], number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

// Order matters — longest match first so "mb" matches before "b"
const byteSuffix = or(istr("kb"), istr("mb"), istr("gb"), istr("b"));

const byteUnitParser: Parser<UnitLiteral> = label("a byte unit literal", (input: string): ParserResult<UnitLiteral> => {
  const parser = seqC(
    set("type", "unitLiteral"),
    set("dimension", "bytes"),
    capture(unsignedNumberChars, "value"),
    capture(byteSuffix, "unit"),
  );
  const result = parser(input);
  if (!result.success) return result;
  const { value, unit } = result.result;
  const normalizedUnit = unit.toLowerCase() as ByteUnitLiteral["unit"];
  return success({
    ...result.result,
    canonicalValue: Math.round(parseFloat(value) * BYTE_MULTIPLIERS[normalizedUnit]),
  } as UnitLiteral, result.rest);
});

export const unitLiteralParser: Parser<UnitLiteral> = label("a unit literal",
  // Order matters: byteUnitParser before timeUnitParser so "1kb" doesn't match
  // as time "1k" (which would fail anyway, but more importantly "5mb" matches
  // as bytes rather than as time "5m" with leftover "b").
  or(costUnitParser, byteUnitParser, timeUnitParser)
);

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

// `_stringParser` is written as a plain function (rather than `seqC`) so it
// can capture the opening delimiter and require the *same* character to
// close. This is what allows the other quote characters to appear unescaped
// inside the string — e.g. backticks and single quotes inside `"…"`, etc.
//
// `simpleStringParser` (no interpolation) just reuses tarsec's `quotedString`
// (which already enforces matching open/close delimiters and supports `"`,
// `'`, and `` ` `` natively). We capture the opening char before delegating
// so the returned node remembers which delimiter the user wrote.
export const simpleStringParser: Parser<StringLiteral> = (input: string) => {
  const first = input[0];
  if (first !== '"' && first !== "'" && first !== "`") {
    return failure(`expected '"', "'", or '\`'`, input);
  }
  const delim = first as '"' | "'" | "`";
  return map(quotedString, (s) => ({
    type: "string" as const,
    segments: [{ type: "text" as const, value: s.slice(1, -1) }],
    delimiter: delim,
  }))(input);
};

// Identifier-only interpolation segment: accepts `${name}` where `name`
// is a plain identifier. Used in static tag-arg strings so users can
// embed a value-param identifier (e.g. `${divisor}`) without opening
// the door to arbitrary runtime expressions. Note: only value-param
// identifiers are actually supported end-to-end — top-level static
// consts are rejected later by `validateStringLiteral` and would crash
// at codegen, since tag strings are emitted where module-level Agency
// consts are not bound as plain JS names.
const staticInterpolationSegmentParser: Parser<InterpolationSegment> =
  withLoc((input: string) => {
    const parser = seqC(
      char("$"),
      char("{"),
      optionalSpaces,
      capture(variableNameParser, "expression"),
      optionalSpaces,
      char("}"),
    );
    const result = parser(input);
    if (!result.success) return result;
    return success(
      {
        type: "interpolation" as const,
        expression: result.result.expression,
      },
      result.rest,
    );
  });

// String literal that allows identifier-only `${name}` interpolation but
// nothing else. Used by `staticTagArgParser` so e.g.
// `@jsonSchema({ description: "divisible by ${divisor}" })` is accepted
// when `divisor` is a value-param name on the surrounding alias, while
// `"${a + b}"`, `"${foo()}"`, `"${obj.field}"` are rejected by the
// parser before reaching the type checker / generator. Static const
// names are not supported here — see the comment on
// `staticInterpolationSegmentParser`.
export const staticInterpolatedStringParser: Parser<StringLiteral> =
  makeInterpolatedStringParser(staticInterpolationSegmentParser);

// Multi-line variant of `staticInterpolatedStringParser`. Same
// identifier-only interpolation rule for `${...}` slots, used inside
// `staticTagArgParser` so a tag arg can be a `"""..."""` literal.
export const staticMultiLineStringParser: Parser<MultiLineStringLiteral> = (
  input: string,
) => {
  const parser = seqC(
    set("type", "multiLineString"),
    str('"""'),
    capture(
      many(
        or(multiLineStringTextSegmentParser, staticInterpolationSegmentParser),
      ),
      "segments",
    ),
    str('"""'),
  );
  const result = parser(input);
  if (result.success) {
    for (const seg of result.result.segments) {
      if (seg.type === "text") seg.value = stripSentinels(seg.value);
    }
  }
  return result;
};

// Build a string-literal parser that supports `"..."` / `` `...` ``
// delimiters, requires matching open/close delimiters, and accepts
// the given interpolation-segment parser inside `${...}` slots.
// Shared between the full `_stringParser` (any expression inside
// `${...}`) and `staticInterpolatedStringParser` (identifier-only).
function makeInterpolatedStringParser(
  segmentParser: Parser<InterpolationSegment>,
): Parser<StringLiteral> {
  return (input: string) => {
    const open = oneOf("\"'`")(input);
    if (!open.success) return open as ParserResult<StringLiteral>;
    const delim = open.result as '"' | "'" | "`";
    const segments = many(
      or(stringTextSegmentParserFor(delim), segmentParser),
    )(open.rest);
    if (!segments.success) return segments as ParserResult<StringLiteral>;
    const close = char(delim)(segments.rest);
    if (!close.success) return failure(`expected closing ${delim}`, input);
    return success(
      { type: "string" as const, segments: segments.result, delimiter: delim },
      close.rest,
    );
  };
}

export const _stringParser: Parser<StringLiteral> =
  makeInterpolatedStringParser(interpolationSegmentParser);

export const stringParser: Parser<StringLiteral> = label("a string", (input: string) => {
  // Allow `_valueAccessParser` on the right of `+` so function calls and
  // chained accesses (`foo()`, `foo.bar`, `foo.bar()`, `foo[0]`) interpolate
  // correctly. Without this, `"hi" + foo()` would parse `"hi" + foo` as a
  // string with `foo` interpolated and leave `()` unparsed.
  const parser = sepBy1(plusSign, or(_stringParser, lazy(() => _valueAccessParser)));
  const result = parser(input);
  if (!result.success) {
    return result;
  }

  const parsed = result.result;
  if (parsed.length === 1 && parsed[0].type !== "string") {
    return failure("Expected string literal", input);
  }

  const segments: (TextSegment | InterpolationSegment)[] = [];
  let delimiter: '"' | "'" | "`" | undefined;
  parsed.forEach((part) => {
    if (part.type === "string") {
      segments.push(...part.segments);
      // For `"a" + 'b' + ...`-style concatenation, keep the delimiter
      // of the first string piece. The formatter sees one merged
      // StringLiteral anyway, so we have to pick one.
      if (delimiter === undefined && part.delimiter !== undefined) {
        delimiter = part.delimiter;
      }
    } else {
      segments.push({
        type: "interpolation",
        expression: part as Expression,
      });
    }
  });
  for (const seg of segments) {
    if (seg.type === "text") seg.value = stripSentinels(seg.value);
  }
  return success(
    {
      type: "string" as const,
      segments,
      ...(delimiter !== undefined ? { delimiter } : {}),
    },
    result.rest,
  );
});

export const multiLineStringParser: Parser<MultiLineStringLiteral> = (input: string) => {
  const parser = seqC(
    set("type", "multiLineString"),
    str('"""'),
    capture(
      many(or(multiLineStringTextSegmentParser, interpolationSegmentParser)),
      "segments",
    ),
    str('"""'),
  );
  const result = parser(input);
  if (result.success) {
    for (const seg of result.result.segments) {
      if (seg.type === "text") seg.value = stripSentinels(seg.value);
    }
  }
  return result;
};

export const variableNameParser: Parser<VariableNameLiteral> = label("an identifier", memo("variableNameParser", (
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
}));

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

export const literalParser: Parser<Literal> = memo("literalParser", or(
  nullParser,
  booleanParser,
  unitLiteralParser,
  numberParser,
  multiLineStringParser,
  stringParser,
  variableNameParser,
));

export const literalParserNoVarName: Parser<Literal> = or(
  nullParser,
  booleanParser,
  unitLiteralParser,
  numberParser,
  multiLineStringParser,
  stringParser,
);

// no string concat, no prompt strings
export function simpleLiteralParser(input: string): ParserResult<Literal> {
  const parser = or(
    booleanParser,
    unitLiteralParser,
    numberParser,
    _stringParser,
    variableNameParser,
  );
  return parser(input);
}

// =============================================================================
// typeHints.ts
// =============================================================================

export const primitiveTypeParser: Parser<PrimitiveType> = memo(
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
        str("function"),
        str("regex"),
      ),
      "value",
    ),
  ),
);

/**
 * Shared `(arg1, arg2, ...)` value-arg suffix parser. Used by both
 * `typeAliasVariableParser` (e.g. `Age(18)`) and `genericTypeParser`
 * (e.g. `BoundedList<string>(3)`). Each arg is restricted to the
 * statically-known subset enforced by `staticTagArgParser`.
 *
 * Defined as a lazy reference so it can be used by parsers that appear
 * earlier in the file than `staticTagArgParser` itself.
 */
const optionalValueArgsParser = optional(
  captureCaptures(
    seqC(
      char("("),
      optionalSpaces,
      capture(
        sepBy(
          seqR(optionalSpaces, char(","), optionalSpaces),
          lazy(() => staticTagArgParser),
        ),
        "valueArgs",
      ),
      optionalSpaces,
      char(")"),
    ),
  ),
);

export const typeAliasVariableParser: Parser<TypeAliasVariable> = memo(
  "typeAliasVariableParser",
  (input: string): ParserResult<TypeAliasVariable> => {
    const parser = seqC(
      set("type", "typeAliasVariable"),
      capture(many1WithJoin(varNameChar), "aliasName"),
      optionalValueArgsParser,
    );
    return parser(input);
  },
);

/**
 * `(T)` — a parenthesized type expression. Lets users write things like
 * `(name | serving_size)[]` or `(string | number)[]` where the union
 * needs to be grouped before the array suffix can apply.
 */
export const parenthesizedTypeParser: Parser<VariableType> = memo(
  "parenthesizedTypeParser",
  map(
    seqC(
      char("("),
      optionalSpaces,
      capture(lazy(() => variableTypeParser), "inner"),
      optionalSpaces,
      char(")"),
    ),
    (result) => result.inner,
  ),
);

export const arrayTypeParser: Parser<ArrayType> = (input: string) => {
  const parser = trace(
    "arrayTypeParser",
    seqC(
      set("type", "arrayType"),
      capture(
        or(
          parenthesizedTypeParser,
          objectTypeParser,
          lazy(() => resultTypeParser),
          lazy(() => angleBracketsArrayTypeParser),
          lazy(() => genericTypeParser),
          primitiveTypeParser,
          typeAliasVariableParser,
        ),
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
export const angleBracketsArrayTypeParser: Parser<ArrayType> = memo(
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

export const stringLiteralTypeParser: Parser<StringLiteralType> = memo(
  "stringLiteralTypeParser",
  seqC(
    set("type", "stringLiteralType"),
    char('"'),
    capture(many1Till(char('"')), "value"),
    char('"'),
  ),
);

export const numberLiteralTypeParser: Parser<NumberLiteralType> = memo(
  "numberLiteralTypeParser",
  seqC(
    set("type", "numberLiteralType"),
    capture(map(many1WithJoin(or(char("-"), char("."), char("_"), digit)), (v) => v.replace(/_/g, "")), "value"),
  ),
);

export const booleanLiteralTypeParser: Parser<BooleanLiteralType> = memo(
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

export const objectPropertyParser: Parser<ObjectProperty> = memo(
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
  memo(
    "objectPropertyDescriptionParser",
    seqC(
      char("#"),
      optionalSpaces,
      capture(many1Till(oneOf(",;\n")), "description"),
    ),
  );

export const objectPropertyWithDescriptionParser: Parser<ObjectProperty> =
  memo(
    "objectPropertyWithDescriptionParser",
    seqC(
      captureCaptures(objectPropertyParser),
      spaces,
      captureCaptures(objectPropertyDescriptionParser),
    ),
  );

/**
 * Parses one or more `@tag(...)` lines, then a property, attaching the
 * tags to that property's `tags` field. Used inside `objectTypeParser`
 * so users can write:
 *
 *     type User = {
 *       @validate(isEmail)
 *       @jsonSchema({ format: "email" })
 *       email: string
 *     }
 */
export const taggedObjectPropertyParser: Parser<ObjectProperty> = memo(
  "taggedObjectPropertyParser",
  (input: string): ParserResult<ObjectProperty> => {
    const parser = seqC(
      capture(
        many1(
          seqC(
            captureCaptures(lazy(() => tagParser)),
            optionalSpacesOrNewline,
          ),
        ),
        "tagWrappers",
      ),
      capture(
        or(
          lazy(() => objectPropertyWithDescriptionParser),
          lazy(() => objectPropertyParser),
        ),
        "prop",
      ),
    );
    const result = parser(input);
    if (!result.success) return result;
    const tags = (result.result.tagWrappers as Array<any>).map(
      (w) => ({ type: "tag", name: w.name, arguments: w.arguments, loc: w.loc }),
    ) as Tag[];
    return success(
      { ...(result.result.prop as ObjectProperty), tags },
      result.rest,
    );
  },
);

type ObjectBodyEntry =
  | { kind: "prop"; prop: ObjectProperty }
  | {
      kind: "trivia";
      node: AgencyComment | AgencyMultiLineComment | NewLine;
    };

const objectMemberWithDelimiter: Parser<ObjectBodyEntry> = (input: string) => {
  const parser = seqC(
    capture(
      or(
        taggedObjectPropertyParser,
        objectPropertyWithDescriptionParser,
        objectPropertyParser,
      ),
      "prop",
    ),
    optional(objectPropertyDelimiter),
  );
  const result = parser(input);
  if (!result.success) return result;
  return success(
    { kind: "prop" as const, prop: result.result.prop as ObjectProperty },
    result.rest,
  );
};

// Consumes a single trivia entry (blank line, line comment, or multi-line
// comment) plus any trailing whitespace/newlines so the cursor is left at
// the start of the next member or trivia entry. `multiLineCommentParser`
// in particular does NOT eat its trailing newline, so we add it here to
// keep `many(or(...))` making progress.
const objectTrivia: Parser<ObjectBodyEntry> = (input: string) => {
  const parser = seqC(
    capture(
      or(blankLineParser, commentParser, multiLineCommentParser),
      "node",
    ),
    optionalSpacesOrNewline,
  );
  const result = parser(input);
  if (!result.success) return result;
  return success(
    {
      kind: "trivia" as const,
      node: result.result.node as
        | AgencyComment
        | AgencyMultiLineComment
        | NewLine,
    },
    result.rest,
  );
};

export const objectTypeParser: Parser<ObjectType> = memo(
  "objectTypeParser",
  (input: string): ParserResult<ObjectType> => {
    const parser = seqC(
      set("type", "objectType"),
      char("{"),
      optionalSpacesOrNewline,
      capture(many(or(objectTrivia, objectMemberWithDelimiter)), "entries"),
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

    // Walk the interleaved entries and split into `properties` + `trivia`.
    // Trivia is anchored to the next property's index. Any trailing trivia
    // (after the last property) is anchored at `properties.length`.
    const properties: ObjectProperty[] = [];
    const trivia: ObjectTypeTrivia[] = [];
    let pending: (AgencyComment | AgencyMultiLineComment | NewLine)[] = [];

    const entries = result.result.entries as ObjectBodyEntry[];
    for (const entry of entries) {
      if (entry.kind === "trivia") {
        pending.push(entry.node);
      } else {
        if (pending.length > 0) {
          trivia.push({ anchorIndex: properties.length, comments: pending });
          pending = [];
        }
        properties.push(entry.prop);
      }
    }
    if (pending.length > 0) {
      trivia.push({ anchorIndex: properties.length, comments: pending });
    }

    const objectType: ObjectType = { type: "objectType", properties };
    if (trivia.length > 0) {
      objectType.trivia = trivia;
    }
    return success(objectType, result.rest);
  },
);

export const unionItemParser: Parser<VariableType> = memo(
  "unionItemParser",
  or(
    lazy(() => blockTypeParser),
    objectTypeParser,
    angleBracketsArrayTypeParser,
    arrayTypeParser,
    lazy(() => resultTypeParser),
    lazy(() => genericTypeParser),
    stringLiteralTypeParser,
    numberLiteralTypeParser,
    booleanLiteralTypeParser,
    primitiveTypeParser,
    typeAliasVariableParser,
    parenthesizedTypeParser,
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

export const unionTypeParser: Parser<UnionType> = memo(
  "unionTypeParser",
  _unionTypeParser,
);

// Block type: () -> string, (number) -> any, (string, number) -> boolean
// Params may be named or unnamed: (userMsg: string) -> string, (string) -> string.
// Both `->` (preferred, matches inline-block lambda syntax) and `=>` (legacy)
// are accepted; the formatter rewrites `=>` to `->` on next save.
const blockTypeParam: Parser<{ name: string; typeAnnotation: VariableType }> =
  or(
    // Named param: `ident : type`. Try this alternative first — once we
    // see `ident :` we're committed (no other grammar produces that shape
    // inside a block-type param list). `seqC` + `capture` already yields
    // `{ name, typeAnnotation }`, no `map` wrapper needed.
    seqC(
      capture(many1WithJoin(varNameChar), "name"),
      optionalSpaces,
      char(":"),
      optionalSpaces,
      capture(lazy(() => variableTypeParser), "typeAnnotation"),
    ) as Parser<{ name: string; typeAnnotation: VariableType }>,
    // Unnamed (legacy): bare type. The AST keeps `name: ""` as a marker.
    map(
      lazy(() => variableTypeParser),
      (t) => ({ name: "", typeAnnotation: t }),
    ),
  );

export const blockTypeParser: Parser<BlockType> = memo(
  "blockTypeParser",
  (input: string): ParserResult<BlockType> => {
    const parser = seqC(
      set("type", "blockType"),
      char("("),
      optionalSpaces,
      capture(
        sepBy(
          seqR(optionalSpaces, char(","), optionalSpaces),
          blockTypeParam,
        ),
        "params",
      ),
      optionalSpaces,
      char(")"),
      optionalSpaces,
      or(str("->"), str("=>")),
      optionalSpaces,
      capture(lazy(() => variableTypeParser), "returnType"),
    );
    const result = parser(input);
    if (!result.success) return result;
    return success(
      {
        type: "blockType" as const,
        params: result.result.params as {
          name: string;
          typeAnnotation: VariableType;
        }[],
        returnType: result.result.returnType,
      },
      result.rest,
    );
  },
);

export const resultTypeParser: Parser<ResultType> = memo(
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
    // Success<T> — sugar for Result<T, any>
    seqC(
      set("type", "resultType"),
      str("Success"),
      char("<"),
      captureCaptures(seqC(
        capture(lazy(() => variableTypeParser), "successType"),
        char(">"),
      )),
      set("failureType", { type: "primitiveType", value: "any" }),
    ),
    // Bare Success (sugar for Result<any, any>)
    seqC(
      set("type", "resultType"),
      str("Success"),
      not(varNameChar),
      set("successType", { type: "primitiveType", value: "any" }),
      set("failureType", { type: "primitiveType", value: "any" }),
    ),
    // Failure<E> — sugar for Result<any, E>
    seqC(
      set("type", "resultType"),
      str("Failure"),
      char("<"),
      captureCaptures(seqC(
        capture(lazy(() => variableTypeParser), "failureType"),
        char(">"),
      )),
      set("successType", { type: "primitiveType", value: "any" }),
    ),
    // Bare Failure (sugar for Result<any, any>)
    seqC(
      set("type", "resultType"),
      str("Failure"),
      not(varNameChar),
      set("successType", { type: "primitiveType", value: "any" }),
      set("failureType", { type: "primitiveType", value: "any" }),
    ),
  ),
);

/**
 * Generic type usage: `Name<TypeArg1, TypeArg2, ...>`. Produces a
 * `genericType` AST node. The parser is policy-free — it does not
 * special-case any name. The type checker's `resolveType` normalizes
 * built-ins (`Array`, `Schema`, `Record`) and resolves user-defined
 * generic aliases by substituting type parameters into the alias body.
 *
 * Ordering: must come AFTER `resultTypeParser` (which keeps its own AST
 * node for `Result<T, E>`) and BEFORE `typeAliasVariableParser` (which
 * greedily matches any identifier).
 */
export const genericTypeParser: Parser<GenericType> = memo(
  "genericTypeParser",
  seqC(
    set("type", "genericType"),
    capture(many1WithJoin(varNameChar), "name"),
    char("<"),
    optionalSpaces,
    capture(
      sepBy1(
        seqR(optionalSpaces, char(","), optionalSpaces),
        lazy(() => variableTypeParser),
      ),
      "typeArgs",
    ),
    optionalSpaces,
    char(">"),
    // Optional value-arg suffix: combined `<T>(n)` form for
    // value-parameterized generic aliases (e.g. `BoundedList<string>(3)`).
    optionalValueArgsParser,
  ),
);

export const variableTypeParser: Parser<VariableType> = memo(
  "variableTypeParser",
  or(
    blockTypeParser,
    unionTypeParser,
    arrayTypeParser,
    objectTypeParser,
    angleBracketsArrayTypeParser,
    resultTypeParser,
    genericTypeParser,
    stringLiteralTypeParser,
    numberLiteralTypeParser,
    booleanLiteralTypeParser,
    primitiveTypeParser,
    typeAliasVariableParser,
    parenthesizedTypeParser,
  ),
);

/**
 * Type parameter on a generic alias declaration. Examples:
 *   T            → { name: "T" }
 *   V = any      → { name: "V", default: { type: "primitiveType", value: "any" } }
 */
export const typeParamParser: Parser<TypeParam> = memo(
  "typeParamParser",
  seqC(
    capture(many1WithJoin(varNameChar), "name"),
    optional(
      captureCaptures(
        seqC(
          optionalSpaces,
          char("="),
          optionalSpaces,
          capture(lazy(() => variableTypeParser), "default"),
        ),
      ),
    ),
  ),
);

/**
 * Value parameter on a value-parameterized alias declaration. Examples:
 *   min: number              → { name: "min", type: { type: "primitiveType", value: "number" } }
 *   min: number = 0          → { ..., default: { type: "number", value: "0" } }
 *
 * The default expression is restricted to the same statically-known
 * subset as tag arguments (see `staticTagArgParser`).
 */
export const valueParamParser: Parser<ValueParam> = memo(
  "valueParamParser",
  seqC(
    capture(many1WithJoin(varNameChar), "name"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(lazy(() => variableTypeParser), "type"),
    optional(
      captureCaptures(
        seqC(
          optionalSpaces,
          char("="),
          optionalSpaces,
          capture(lazy(() => staticTagArgParser), "default"),
        ),
      ),
    ),
  ),
);

const baseTypeAliasParser: Parser<TypeAlias> = withLoc(memo(
  "typeAliasParser",
  seqC(
    set("type", "typeAlias"),
    str("type"),
    spaces,
    captureCaptures(
      parseError(
        "expected a statement of the form `type Foo = X' where X can be a union, array, object, type alias, or primitive type`",
        capture(many1WithJoin(varNameChar), "aliasName"),
        // Optional `<T, U = Default, ...>`. When absent, no `typeParams`
        // capture is set, so non-generic aliases keep their existing shape.
        optional(
          captureCaptures(
            seqC(
              char("<"),
              optionalSpaces,
              capture(
                sepBy1(
                  seqR(optionalSpaces, char(","), optionalSpaces),
                  typeParamParser,
                ),
                "typeParams",
              ),
              optionalSpaces,
              char(">"),
            ),
          ),
        ),
        // Optional `(name: T, name: T = default, ...)`. Must come AFTER the
        // optional `<...>` block: reversed ordering `(...)<...>` is rejected
        // because nothing here consumes a `<` before the `=`.
        optional(
          captureCaptures(
            seqC(
              char("("),
              optionalSpaces,
              capture(
                sepBy1(
                  seqR(optionalSpaces, char(","), optionalSpaces),
                  valueParamParser,
                ),
                "valueParams",
              ),
              optionalSpaces,
              char(")"),
            ),
          ),
        ),
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

// A single statically-restricted argument expression. Shared by:
//   1. `@validate(...)` / `@jsonSchema(...)` tag arguments
//   2. value-parameter default expressions (`= 0`)
//   3. value-arg expressions at use sites (`Age(18)`)
//
// The underlying rule: allowed expressions are exactly those whose value
// is statically known at compile time, so they can be substituted into a
// tag expression and emitted as a TypeScript literal.
//
// Allowed: string / number / boolean / null literals (NO `${...}`
// interpolation — see below), identifiers (resolving to a static const
// or value-param in scope), object literals (including spread), and PFA
// expressions (e.g. `min.partial(n: 0)`) whose base is a plain
// identifier.
//
// NOT allowed:
//   - bare function calls (no chain). Use PFA: `min.partial(n: 0)`.
//   - PFA whose base is a function-call (`getMin(1).partial(...)`) —
//     base must be a plain identifier.
//   - ternaries, binary ops, pipes.
//   - member access (`obj.field`).
//   - interpolated string segments. Plain `simpleStringParser` accepts
//     only literal-only strings; any `${...}` inside a string would
//     embed a runtime expression that can't be folded at compile time.
//   - array literals. (Could be allowed via constant folding in a
//     future iteration; deferred until a stdlib use case needs them.)
//
// All forward references go through lazy(...) because these parsers
// are defined later in the file.
const _identOrPfaParser: Parser<Expression> = (input: string) => {
  const result = lazy(() => _valueAccessParser)(input);
  if (!result.success) return result;
  // Reject bare function calls (no chain). PFA expressions (function
  // call followed by a `.partial(...)` style method-call chain) are
  // `valueAccess` nodes and so survive this filter. Bare identifiers
  // (`variableName`) are also fine.
  if (result.result.type === "functionCall") {
    return failure(
      "bare function call not allowed; use a literal, identifier, PFA expression (e.g. `min.partial(n: 0)`), or object literal",
      input,
    );
  }
  // Reject PFA whose base isn't a plain identifier. `foo(1).partial(...)`
  // and `(get()).partial(...)` are NOT static — they call a function at
  // runtime to compute the receiver. PFA must be rooted at an identifier
  // (typically a top-level validator function in scope).
  if (
    result.result.type === "valueAccess" &&
    result.result.base.type !== "variableName"
  ) {
    return failure(
      "PFA base must be a plain identifier (e.g. `min.partial(n: 0)`, not `min(1).partial(...)`)",
      input,
    );
  }
  return result;
};

export const staticTagArgParser: Parser<Expression> = label(
  "a static argument (literal, identifier, PFA expression, array, object, regex, or unit literal)",
  or(
    lazy(() => agencyObjectParser),
    lazy(() => agencyArrayParser),
    regexLiteralParser,
    nullParser,
    booleanParser,
    // Unit literals (`30s`, `$5`, `100KB`, ...) MUST come before
    // `numberParser` so `30s` matches as a unit and not as `30`
    // with stray `s`. The IR carries `canonicalValue` (already
    // normalised to ms / dollars / bytes), which is what codegen
    // emits.
    unitLiteralParser,
    numberParser,
    // Triple-quoted strings before single-quoted so `"""..."""`
    // isn't first matched as an empty `""` followed by `"..."`.
    staticMultiLineStringParser,
    // Allow identifier-only `${name}` interpolation so users can
    // reference value-param identifiers inside tag strings (e.g.
    // `description: "must be divisible by ${divisor}"`). Any
    // non-identifier expression in a `${...}` slot is rejected at
    // parse time.
    staticInterpolatedStringParser,
    _identOrPfaParser,
  ),
);

// Backwards-compatible alias for the previous name. The current
// behaviour is the tightened one: bare function calls are rejected.
const restrictedTagArgParser: Parser<Expression> = staticTagArgParser;

// Parenthesized argument list: (arg1, arg2)
const tagArgsList = map(
  seqC(
    char("("),
    optionalSpaces,
    capture(sepBy(comma, restrictedTagArgParser), "args"),
    optionalSpaces,
    char(")"),
  ),
  (result) => result.args,
);

// The full tag: @name or @name(args)
const _tagParserInner = memo(
  "tagParser",
  seqC(
    set("type", "tag"),
    char("@"),
    capture(many1WithJoin(varNameChar), "name"),
    capture(
      or(tagArgsList, succeed([] as Expression[])),
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

const agencyObjectComputedKVParser: Parser<AgencyObjectKV> = memo(
  "agencyObjectComputedKVParser",
  seqC(
    optionalSpaces,
    char("["),
    optionalSpaces,
    set("key", ""),
    capture(
      lazy(() => exprParser),
      "computedKey",
    ),
    optionalSpaces,
    char("]"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(
      lazy(() => exprParser),
      "value",
    ),
  ),
);

const agencyObjectStaticKVParser: Parser<AgencyObjectKV> = memo(
  "agencyObjectStaticKVParser",
  seqC(
    optionalSpaces,
    capture(or(map(quotedString, removeQuotes), many1WithJoin(varNameChar)), "key"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(
      lazy(() => exprParser),
      "value",
    ),
  ),
);

export const agencyObjectKVParser: Parser<AgencyObjectKV> = (
  input: string,
): ParserResult<AgencyObjectKV> =>
  or(agencyObjectComputedKVParser, agencyObjectStaticKVParser)(input);

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

const namedArgumentParser: Parser<NamedArgument> = memo(
  "namedArgumentParser",
  seqC(
    set("type", "namedArgument"),
    capture(many1WithJoin(varNameChar), "name"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(or(lazy(() => inlineBlockParser), lazy(() => exprParser)), "value"),
  ),
);

// Shared argument list parser: (arg1, arg2, \x -> expr, ...)
// Used by both _functionCallParser and callChainParser.
const argumentListParser = memo("argumentListParser", seqC(
  char("("),
  optionalSpacesOrNewline,
  capture(
    sepBy(
      commaWithNewline,
      or(
        namedArgumentParser,
        splatParser,
        lazy(() => inlineBlockParser),
        lazy(() => exprParser),
      ),
    ),
    "arguments",
  ),
  optional(comma),
  optionalSpacesOrNewline,
  char(")"),
));

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

export const _functionCallParser: Parser<FunctionCall> = memo("_functionCallParser", (input: string) => {
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
});

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

const chainElementParser: Parser<AccessChainElement> = memo("chainElementParser", or(
  dotMethodCallParser,
  callChainParser,
  sliceChainParser,
  indexChainParser,
));

/**
 * Parse `( expr ) chain` as a value-access expression. This is what
 * lets a parenthesized expression appear at the start of a body
 * statement (e.g. `(new Foo()).bump()`) and be parsed as a chained
 * call. Only succeeds when there is at least one chain element —
 * bare `(expr)` with no chain falls through so other parsers (like
 * the expression parser's own paren handling) can take over.
 */
const parenAccessParser: Parser<ValueAccess> = map(
  seqC(
    char("("),
    optionalSpaces,
    capture(lazy(() => exprParser), "base"),
    optionalSpaces,
    char(")"),
    capture(many1(chainElementParser), "chain"),
  ),
  (result) =>
    ({
      type: "valueAccess" as const,
      base: result.base as unknown as AgencyNode,
      chain: result.chain,
    }) as ValueAccess,
);

export const _valueAccessParser: Parser<VariableNameLiteral | FunctionCall | ValueAccess> = memo("_valueAccessParser", (
  input: string,
): ParserResult<VariableNameLiteral | FunctionCall | ValueAccess> => {
  // First try the parenthesized form so `(expr).chain` and `(expr)[i]`
  // work as standalone statements (the bodyParser calls _valueAccessParser
  // directly, bypassing the exprParser's own paren handling).
  const parenResult = parenAccessParser(input);
  if (parenResult.success) return parenResult;

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
});

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
export const schemaExpressionParser: Parser<SchemaExpression> = memo(
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
  lazy(() => interruptExprParser),
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
//
// After the closing `)`, try to parse an access chain (`.field`, `[i]`,
// `.method()`, `(...)`, etc.). If any chain element matches, wrap the
// result in a ValueAccess so things like `(a + b).toString()`,
// `(arr)[0]`, and `(new Foo()).method()` work as expected.
// eslint-disable-next-line prefer-const -- reassigned at the bottom of this file to break a circular dependency
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

  // Try to attach an access chain to the parenthesized expression.
  const chainResult = many(chainElementParser)(closeResult.rest);
  if (chainResult.success && chainResult.result.length > 0) {
    return success(
      {
        type: "valueAccess" as const,
        base: exprResult.result as unknown as AgencyNode,
        chain: chainResult.result,
      } as ValueAccess as unknown as Expression,
      chainResult.rest,
    );
  }
  return success(exprResult.result, closeResult.rest);
};

// Wrap atom to handle `<atom> is <pattern>` as an IsExpression.
// The check requires whitespace before `is` and a non-identifier char after,
// so identifiers like `island` and `isFoo` are not affected.
const atomWithIs: Parser<Expression> = (input: string) => {
  const baseResult = atom(input);
  if (!baseResult.success) return baseResult;
  const isCheck = seqC(
    spaces,
    str("is"),
    not(varNameChar),
    optionalSpaces,
    capture(lazy(() => matchPatternParser), "pattern"),
  )(baseResult.rest);
  if (!isCheck.success) return baseResult;
  return success(
    {
      type: "isExpression",
      expression: baseResult.result,
      pattern: (isCheck.result as any).pattern,
    } as IsExpression,
    isCheck.rest,
  );
};

// Operator table: highest precedence first.
// Multi-char operators must come before their single-char prefixes
// (e.g., *= before *, <= before <).
export const exprParser: Parser<Expression> = label("an expression", memo("exprParser", buildExpressionParser<Expression>(
  atomWithIs,
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
)));

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
// interruptStatement.ts
// =============================================================================

// Namespace identifier: two or more segments separated by "::"
// e.g. "std::read", "myapp::deploy", "std::http::fetch"
const namespaceIdentifier: Parser<string> = (input: string) => {
  const parser = map(
    sepBy1(str("::"), many1WithJoin(varNameChar)),
    (segments) => segments.join("::"),
  );
  const result = parser(input);
  if (!result.success) return result;
  if (!result.result.includes("::")) {
    return failure("expected interrupt kind with ::, e.g. std::read or myapp::deploy", input);
  }
  return result;
};

// Core interrupt parser without trailing whitespace/semicolons (for use in expressions)
// Handles both structured `interrupt std::read("msg")` and bare `interrupt("msg")` forms.
// Bare form gets kind "unknown".
const _interruptExprParser: Parser<InterruptStatement> = (input: string) => {
  // Try structured form first: interrupt <namespace>(<args>)
  const structured = seqC(
    set("type", "interruptStatement"),
    str("interrupt"),
    spaces,
    capture(namespaceIdentifier, "kind"),
    captureCaptures(argumentListParser),
  )(input);
  if (structured.success) return success(structured.result as InterruptStatement, structured.rest);

  // Bare form: interrupt(<args>) — no namespace, kind defaults to "unknown"
  const bare = seqC(
    set("type", "interruptStatement"),
    str("interrupt"),
    set("kind", "unknown"),
    captureCaptures(argumentListParser),
  )(input);
  if (!bare.success) return bare;
  return success(bare.result as InterruptStatement, bare.rest);
};

export const interruptExprParser: Parser<InterruptStatement> = withLoc(_interruptExprParser);

export const interruptStatementParser: Parser<InterruptStatement> = label("an interrupt statement", withLoc(
  (input: string) => {
    const result = _interruptExprParser(input);
    if (!result.success) return result;
    // Consume trailing semicolon/whitespace
    const semiResult = optionalSemicolon(result.rest);
    const wsResult = optionalSpacesOrNewline(semiResult.success ? semiResult.rest : result.rest);
    return success(result.result, wsResult.success ? wsResult.rest : (semiResult.success ? semiResult.rest : result.rest));
  },
));

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

// Parse a single block parameter with optional type annotation:
//   x         — untyped (types inferred from function signature or default to any)
//   x: number — explicitly typed
const blockParamParser: Parser<FunctionParameter> = memo(
  "blockParamParser",
  seqC(
    set("type", "functionParameter"),
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

export const asParser = (input: string): ParserResult<FunctionParameter[]> => {

  const parser = seqC(
    str("as"),
    spaces,
    capture(blockParamsParser, "params"),
  )
  const result = parser(input);
  if (!result.success) return success([], input); // "as" is optional, so if it doesn't match, return empty params and original input
  return success(result.result.params, result.rest);
}


// Parse a block argument. Always requires "as" keyword:
//   as params { body }     — with params
//   as { body }            — no params
export const blockArgumentParser: Parser<BlockArgument> = memo(
  "blockArgumentParser",
  seqC(
    set("type", "blockArgument"),
    set("inline", false),
    capture(asParser, "params"),
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
export const inlineBlockParser: Parser<BlockArgument> = memo(
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

// `_` followed by a non-identifier char. Without the `not(varNameChar)` check,
// `_foo` would partially match as `_` and leave `foo` unconsumed.
export const defaultCaseParser: Parser<DefaultCase> = map(
  seqC(char("_"), not(varNameChar)),
  () => "_" as DefaultCase,
);

// Match arm LHS parser. Tries in order:
//   1. `_` (default case)
//   2. matchPattern, but only accepts if followed by `=>` or ` if (...)` —
//      this prevents `v` from being parsed as a pattern when the user wrote
//      `v > 5 =>` in `match(x is pat)` guard form.
//   3. exprParser, as a fallback for guard expressions.
const caseLhsParser: Parser<unknown> = (input: string) => {
  const def = defaultCaseParser(input);
  if (def.success) return def;

  const pat = lazy(() => matchPatternParser)(input);
  if (pat.success) {
    // Look ahead: is the next non-space token `=>` or `if`?
    const trimmed = pat.rest.replace(/^[ \t]+/, "");
    if (trimmed.startsWith("=>") || /^if[^A-Za-z0-9_]/.test(trimmed)) {
      return pat;
    }
  }

  return exprParser(input);
};

export const matchBlockParserCase: Parser<MatchBlockCase> = (
  input: string,
): ParserResult<MatchBlockCase> => {
  const parser = seqC(
    set("type", "matchBlockCase"),
    optionalSpaces,
    capture(caseLhsParser, "caseValue"),
    // Optional guard: ` if (<expr>)`
    optional(
      captureCaptures(
        seqC(
          spaces,
          str("if"),
          not(varNameChar),
          optionalSpaces,
          char("("),
          optionalSpaces,
          capture(exprParser, "guard"),
          optionalSpaces,
          char(")"),
        ),
      ),
    ),
    optionalSpaces,
    str("=>"),
    optionalSpaces,
    capture(or(returnStatementParser, lazy(() => assignmentParser), exprParser), "body"),
    optionalSemicolon,
    optionalSpacesOrNewline,
  );
  return parser(input) as ParserResult<MatchBlockCase>;
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
      capture(many(or(blankLineParser, commentParser, matchBlockParserCase)), "cases"),
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

export const importNodeStatmentParser: Parser<ImportNodeStatement> = memo(
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
        optionalSpacesOrNewline,
        capture(sepBy1(commaWithNewline, many1WithJoin(varNameChar)), "importedNodes"),
        optionalSpacesOrNewline,
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


const namedImportParser: Parser<NamedImport> = memo(
  "namedImportParser",
  map(
    seqC(
      char("{"),
      optionalSpacesOrNewline,
      capture(sepBy1(commaWithNewline, safeNameItem), "items"),
      optional(commaWithNewline),
      optionalSpacesOrNewline,
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

const namespaceImportParser: Parser<NamespaceImport> = memo(
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

const defaultImportParser: Parser<DefaultImport> = memo(
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
  memo(
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
// exportFromStatement.ts — `export { x } from "..."` and `export * from "..."`
// =============================================================================

const namedExportBodyParser = map(
  seqC(
    char("{"),
    optionalSpacesOrNewline,
    capture(sepBy1(commaWithNewline, safeNameItem), "items"),
    optional(commaWithNewline),
    optionalSpacesOrNewline,
    char("}"),
  ),
  (result) => {
    const names: string[] = [];
    const safeNames: string[] = [];
    const aliases: Record<string, string> = {};
    for (const item of result.items) {
      names.push(item.name);
      if (item.alias) aliases[item.name] = item.alias;
      if (item.isSafe) safeNames.push(item.name);
    }
    return { kind: "namedExport" as const, names, safeNames, aliases };
  },
);

const starExportBodyParser = map(char("*"), () => ({
  kind: "starExport" as const,
}));

const exportBodyParser = or(namedExportBodyParser, starExportBodyParser);

// Note: deliberately uses plain `seqC` (not `parseError`) so that the parser
// fails cleanly on inputs like `export def foo()` and `or` falls through to
// functionParser, graphNodeParser, etc.
export const exportFromStatementParser: Parser<ExportFromStatement> = withLoc(
  map(
    memo(
      "exportFromStatement",
      seqC(
        set("type", "exportFromStatement"),
        str("export"),
        spaces,
        capture(exportBodyParser, "body"),
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
    (result) => ({ ...result, isAgencyImport: isAgencyImport(result.modulePath) }),
  ),
);

// =============================================================================
// function.ts (the big one — assignment, body, nodes, functions, loops, etc.)
// =============================================================================

// Destructuring assignment: `let [a, b] = expr` or `const { x, y } = expr`.
// Tried before the regular assignment parser. Sets variableName to a
// sentinel "__destructured" and records the BindingPattern in `pattern`.
const _destructuringAssignmentParser: Parser<Assignment> = (input: string) => {
  const parser = seqC(
    set("type", "assignment"),
    optionalSpaces,
    capture(or(str("let"), str("const")), "declKind"),
    spaces,
    capture(
      or(
        lazy(() => arrayBindingPatternParser),
        lazy(() => objectBindingPatternParser),
      ),
      "pattern",
    ),
    optionalSpaces,
    char("="),
    optionalSpaces,
    capture(or(lazy(() => messageThreadParser), exprParser), "value"),
    optionalSemicolon,
    optionalSpacesOrNewline,
  );
  const result = parser(input);
  if (!result.success) return result;
  const r = result.result as any;
  return success(
    {
      type: "assignment",
      declKind: r.declKind,
      pattern: r.pattern,
      variableName: "__destructured",
      value: r.value,
    } as Assignment,
    result.rest,
  );
};

const _assignmentParserInner: Parser<Assignment> = (input: string) => {
  // Try destructuring assignment first (let/const + binding pattern + `=` + value).
  const destructuringResult = _destructuringAssignmentParser(input);
  if (destructuringResult.success) return destructuringResult;

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

const staticKeywordParser: Parser<boolean> = or(
  map(seqC(str("static"), spaces), () => true),
  succeed(false),
);

// Parse "export" and "static" in any order before "let"/"const"
export const modifiedAssignmentParser: Parser<Assignment> = withLoc((input: string) => {
  let rest = input;
  let isExported = false;
  let isStatic = false;

  // Try up to 2 modifiers in any order
  for (let i = 0; i < 2; i++) {
    if (!isExported) {
      const exportResult = exportKeywordParser(rest);
      if (exportResult.success && exportResult.result) {
        isExported = true;
        rest = exportResult.rest;
        continue;
      }
    }
    if (!isStatic) {
      const staticResult = staticKeywordParser(rest);
      if (staticResult.success && staticResult.result) {
        isStatic = true;
        rest = staticResult.rest;
        continue;
      }
    }
    break;
  }

  // If no modifiers found, this parser doesn't match
  if (!isExported && !isStatic) return failure("expected 'export' or 'static'", input);

  const result = assignmentParser(rest);
  if (!result.success) return result;

  if (isStatic && result.result.declKind !== "const") {
    return failure("static requires 'const' (e.g., 'static const x = 1'). Static variables are immutable.", input);
  }

  // export requires a declaration (let or const), not a bare reassignment
  if (isExported && !result.result.declKind) {
    return failure("export requires 'let' or 'const' (e.g., 'export const x = 1')", input);
  }

  const out = { ...result.result };
  if (isExported) out.exported = true;
  if (isStatic) out.static = true;
  return success(out, result.rest);
});

/**
 * `static <expression-statement>` at module top level. Routes a bare
 * statement (function call, value access, interrupt) into Phase A so
 * it runs once per process instead of once per agent run. Mirrors the
 * existing `static const`.
 *
 * Probe-and-commit design (matches `reservedClassParser`'s handling
 * of `class`): when the input doesn't start with `static`, we decline
 * silently (`failure("", input)`) so we don't pollute unrelated
 * top-level parse failures. Once the `static` keyword is consumed we
 * commit fatally to any subsequent error, because the alternatives
 * list would otherwise let `or(...)` backtrack and reinterpret
 * `static` as a bare identifier, producing nonsense AST.
 *
 * Routing on what follows `static`:
 *   - `const` → silently decline so `modifiedAssignmentParser` (tried
 *     before this one in the top-level list) owns `static const`.
 *   - `let`   → fatal: tell the user to use `static const` or
 *     `static <expr>`. `modifiedAssignmentParser` rejects this too but
 *     only recoverably, so without a fatal commit here the error
 *     would be lost to backtracking.
 *   - `<ident>\s*=` → fatal: `static foo = 1` would otherwise be
 *     half-eaten as `staticStatement(foo)` and then fail at `=` with
 *     a confusing message; reject it explicitly with the same
 *     actionable guidance as `static let`.
 *   - anything else → try `interruptStatement | functionCall |
 *     valueAccess` and fatally surface any inner-parse failure.
 *
 * Wraps the inner statement in a `StaticStatement` AST node; the
 * section assembler (`partitionProgram`) unwraps the wrapper and
 * routes the inner statement into `staticInitTagged`. After partition
 * the wrapper never appears again — downstream codegen sees only the
 * inner statement.
 */
const STATIC_LET_MESSAGE =
  "`static let` is not allowed. Use `static const <name> = ...` for a " +
  "once-per-process binding, or `static <expr>` (e.g. `static foo()`) " +
  "for a once-per-process side effect.";

const STATIC_ASSIGN_MESSAGE =
  "`static <name> = ...` is not allowed. Use `static const <name> = ...` " +
  "for a once-per-process binding, or `static <expr>` (e.g. `static foo()`) " +
  "for a once-per-process side effect.";

const STATIC_INNER_MESSAGE =
  "`static` at top level must be followed by `const <name> = ...` " +
  "or an expression statement (e.g., `static foo()` or " +
  "`static logger.flush()`).";

export const staticStatementParser: Parser<StaticStatement> = withLoc(
  (input: string) => {
    const kwResult = seqC(str("static"), spaces)(input);
    if (!kwResult.success) {
      // Probe failed — decline silently so we don't contribute a
      // misleading "expected 'static'" message to unrelated top-level
      // parse failures. Matches `reservedClassParser`'s convention.
      return failure("", input);
    }
    const rest = kwResult.rest;
    // `static const` belongs to `modifiedAssignmentParser`. Decline
    // silently so its success path runs (it's tried before this
    // parser in the top-level alternatives list).
    if (/^const\b/.test(rest)) {
      return failure("", input);
    }
    if (/^let\b/.test(rest)) {
      return parseError(
        STATIC_LET_MESSAGE,
        fail("static let"),
      )(input) as ParserResult<StaticStatement>;
    }
    // `static <ident> = ...` would otherwise be half-eaten as a bare
    // statement whose inner is a variableName, and the trailing `=`
    // would surface as a confusing "unexpected token" downstream.
    // Reject up-front so the user gets the actionable "use `static
    // const`" guidance instead.
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.test(rest)) {
      return parseError(
        STATIC_ASSIGN_MESSAGE,
        fail("static <name> ="),
      )(input) as ParserResult<StaticStatement>;
    }
    const innerParser = or(
      interruptStatementParser,
      functionCallParser,
      valueAccessParser,
    );
    const innerResult = innerParser(rest);
    if (!innerResult.success) {
      // Fatal: once we've consumed `static`, any subsequent failure
      // must surface — recoverable failure would let `or(...)`
      // reinterpret `static` as an identifier and yield nonsense AST.
      return parseError(
        STATIC_INNER_MESSAGE,
        fail("static <expr>"),
      )(input) as ParserResult<StaticStatement>;
    }
    return success(
      { type: "staticStatement", statement: innerResult.result as AgencyNode },
      innerResult.rest,
    );
  },
);

// Doc strings are parsed identically to multi-line strings. Trimming of
// the leading/trailing indentation is applied at the points that
// actually need normalized text — the LLM tool-description emitter
// (`typescriptBuilder.buildToolDefinition`) and the human-display
// helper (`utils/docStringText`) — so the parser preserves the source
// faithfully for the formatter to round-trip.
export const docStringParser = multiLineStringParser;

const _bodyNodeParser: Parser<AgencyNode> = memo("bodyNodeParser", or(
  keywordParser,
  debug(typeAliasParser, "error in typeAliasParser"),
  tagParser,
  // withModifierParser must be tried before returnStatementParser/
  // assignmentParser so that `return foo() with approve` and
  // `const x = foo() with approve` don't get partially consumed by
  // the inner statement parser, which would leave `with approve`
  // dangling and unparseable.
  lazy(() => withModifierParser),
  returnStatementParser,
  gotoStatementParser,
  interruptStatementParser,
  lazy(() => forLoopParser),
  lazy(() => whileLoopParser),
  lazy(() => parallelBlockParser),
  lazy(() => seqBlockParser),
  matchBlockParser,
  lazy(() => ifParser),
  lazy(() => messageThreadParser),
  lazy(() => handleBlockParser),
  debuggerParser,
  multiLineCommentParser,
  commentParser,
  skillParser,
  assignmentParser,
  binOpParser,
  booleanParser,
  valueAccessParser,
  literalParser,
  blankLineParser,
  newLineParser,
));

const _bodyParserImpl: Parser<AgencyNode[]> = memo(
  "functionBodyParser",
  many(
    map(
      seqC(capture(_bodyNodeParser, "node"), optionalSpacesOrNewline),
      (result) => result.node,
    ),
  ),
);

export const bodyParser = (input: string): ParserResult<AgencyNode[]> => {
  return _bodyParserImpl(input);
};

/** Parse optional `(label: ..., summarize: ..., continue: ..., session: ...)`
 *  before the `{` of a `thread` / `subthread` block. Accepts zero args
 *  via `()` as well as no parens at all. Unknown keys produce a parse
 *  error; `continue` and `session` are mutually exclusive. */
type ThreadNamedArgs = {
  label: Expression | null;
  summarize: Expression | null;
  continueExpr: Expression | null;
  sessionExpr: Expression | null;
  hidden: Expression | null;
};

const _threadNamedArgsParser: Parser<ThreadNamedArgs> = (
  input: string,
): ParserResult<ThreadNamedArgs> => {
  // Reuse the canonical NamedArgument parser shape used by function
  // calls so users get identical syntax / error messages.
  const inner: Parser<any> = seqC(
    char("("),
    optionalSpacesOrNewline,
    capture(
      sepBy(commaWithNewline, namedArgumentParser),
      "arguments",
    ),
    optional(comma),
    optionalSpacesOrNewline,
    char(")"),
  );
  const r = inner(input);
  if (!r.success) return r as ParserResult<ThreadNamedArgs>;
  const args: NamedArgument[] = r.result.arguments;
  const allowed = ["label", "summarize", "continue", "session", "hidden"];
  const seen: Record<string, Expression> = {};
  for (const arg of args) {
    if (!allowed.includes(arg.name)) {
      return failure(
        `Unknown thread argument: ${arg.name}. Allowed: label, summarize, continue, session, hidden`,
        input,
      );
    }
    if (seen[arg.name]) {
      return failure(`Duplicate thread argument: ${arg.name}`, input);
    }
    seen[arg.name] = arg.value as Expression;
  }
  if (seen.continue && seen.session) {
    return failure(
      "thread() cannot use both `continue` and `session` — they are mutually exclusive",
      input,
    );
  }
  return success(
    {
      label: seen.label ?? null,
      summarize: seen.summarize ?? null,
      continueExpr: seen.continue ?? null,
      sessionExpr: seen.session ?? null,
      hidden: seen.hidden ?? null,
    },
    r.rest,
  );
};

export const _messageThreadParser: Parser<MessageThread> = memo(
  "_messageThreadParser",
  seqC(
    set("type", "messageThread"),
    str("thread"),
    set("threadType", "thread"),
    capture(
      optional(_threadNamedArgsParser),
      "_args",
    ),
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
export const _submessageThreadParser: Parser<MessageThread> = memo(
  "_submessageThreadParser",
  seqC(
    set("type", "messageThread"),
    str("subthread"),
    set("threadType", "subthread"),
    capture(
      optional(_threadNamedArgsParser),
      "_args",
    ),
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

/** Lift `_args` (the optional named-args object) to top-level fields on
 *  the MessageThread node. */
const liftThreadArgs = (parsed: any): MessageThread => {
  const args = parsed._args as
    | {
      label: Expression | null;
      summarize: Expression | null;
      continueExpr: Expression | null;
      sessionExpr: Expression | null;
      hidden: Expression | null;
    }
    | null
    | undefined;
  const out: any = { ...parsed };
  delete out._args;
  if (args) {
    out.label = args.label;
    out.summarize = args.summarize;
    out.continueExpr = args.continueExpr;
    out.sessionExpr = args.sessionExpr;
    out.hidden = args.hidden;
  } else {
    out.label = null;
    out.summarize = null;
    out.continueExpr = null;
    out.sessionExpr = null;
    out.hidden = null;
  }
  return out as MessageThread;
};

export const messageThreadParser: Parser<MessageThread> = withLoc(
  map(or(_messageThreadParser, _submessageThreadParser), liftThreadArgs),
);

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

export const handleBlockParser: Parser<HandleBlock> = withLoc(memo(
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
  // Try to parse a static assignment, regular assignment, return, or bare function call as the inner statement.
  const stmtResult = or(modifiedAssignmentParser, assignmentParser, returnStatementParser, functionCallParser)(input);
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

export const whileLoopParser: Parser<WhileLoop> = label("a while loop", withLoc(memo(
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

/** Parser for the optional `(shared: <expr>)` named-args list after
 *  `parallel`. Modelled on `_threadNamedArgsParser` but with a smaller
 *  allowlist. Returns `{ shared: Expression | null }` on success. */
const _parallelNamedArgsParser: Parser<{ shared: Expression | null }> = (
  input: string,
): ParserResult<{ shared: Expression | null }> => {
  const inner: Parser<any> = seqC(
    char("("),
    optionalSpacesOrNewline,
    capture(
      sepBy(commaWithNewline, namedArgumentParser),
      "arguments",
    ),
    optional(comma),
    optionalSpacesOrNewline,
    char(")"),
  );
  const r = inner(input);
  if (!r.success) return r as ParserResult<{ shared: Expression | null }>;
  const args: NamedArgument[] = r.result.arguments;
  const seen: Record<string, Expression> = {};
  for (const arg of args) {
    if (arg.name !== "shared") {
      return failure(
        `Unknown parallel argument: ${arg.name}. Allowed: shared`,
        input,
      );
    }
    if (seen[arg.name]) {
      return failure(`Duplicate parallel argument: ${arg.name}`, input);
    }
    seen[arg.name] = arg.value as Expression;
  }
  return success({ shared: seen.shared ?? null }, r.rest);
};

export const parallelBlockParser: Parser<ParallelBlock> = label("a parallel block", withLoc(map(memo(
  "parallelBlockParser",
  seqC(
    set("type", "parallelBlock"),
    str("parallel"),
    capture(optional(_parallelNamedArgsParser), "_args"),
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
), (parsed: any): ParallelBlock => {
  const args = parsed._args as { shared: Expression | null } | null | undefined;
  const out: any = { ...parsed };
  delete out._args;
  if (args && args.shared !== null) {
    out.shared = args.shared;
  }
  return out as ParallelBlock;
})));

export const seqBlockParser: Parser<SeqBlock> = label("a seq block", withLoc(memo(
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

export const forLoopParser: Parser<ForLoop> = label("a for loop", withLoc(memo(
  "forLoopParser",
  seqC(
    set("type", "forLoop"),
    str("for"),
    optionalSpaces,
    char("("),
    optionalSpaces,
    optional(or(str("let"), str("const"))),
    optionalSpaces,
    capture(
      or(
        lazy(() => arrayBindingPatternParser),
        lazy(() => objectBindingPatternParser),
        many1WithJoin(varNameChar),
      ),
      "itemVar",
    ),
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
export const functionParameterParser: Parser<FunctionParameter> = memo(
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
export const variadicParameterParser: Parser<FunctionParameter> = memo(
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

export const functionReturnTypeParser: Parser<VariableType> = memo(
  "functionReturnTypeParser",
  seqC(
    char(":"),
    optionalSpaces,
    captureCaptures(
      or(variableTypeParser, parseError("Invalid return type", fail("error"))),
    ),
  ),
);

const _baseFunctionParser: Parser<any> = memo(
  "_baseFunctionParser",
  seqC(
    set("type", "function"),
    capture(str("def"), "keyword"),
    many1(space),
    capture(many1Till(char("(")), "functionName"),
    char("("),
    optionalSpacesOrNewline,
    capture(
      sepBy(
        seqC(commaWithNewline, optionalSpaces),
        or(variadicParameterParser, functionParameterParser),
      ),
      "parameters",
    ),
    optional(comma),
    optionalSpacesOrNewline,
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

// Parse "export" and "safe" in any order before "def"
function parseFunctionModifiers(input: string): { success: true; rest: string; isExported: boolean; isSafe: boolean } | { success: false } {
  let rest = input;
  let isExported = false;
  let isSafe = false;

  // Try up to 2 modifiers in any order
  for (let i = 0; i < 2; i++) {
    if (!isExported) {
      const exportResult = exportKeywordParser(rest);
      if (exportResult.success && exportResult.result) {
        isExported = true;
        rest = exportResult.rest;
        continue;
      }
    }
    if (!isSafe) {
      const safeResult = safeKeywordParser(rest);
      if (safeResult.success && safeResult.result) {
        isSafe = true;
        rest = safeResult.rest;
        continue;
      }
    }
    break;
  }

  return { success: true, rest, isExported, isSafe };
}

const _functionParserInner: Parser<FunctionDefinition> = (input: string) => {
  const mods = parseFunctionModifiers(input);
  if (!mods.success) return failure("unexpected modifier", input);
  const { isExported, isSafe } = mods;

  const baseResult = _baseFunctionParser(mods.rest);
  if (!baseResult.success) return baseResult;

  const { keyword: _keyword, returnTypeValidated: _rtv, ...rest } = baseResult.result as any;
  const result = { ...rest } as FunctionDefinition;
  if (_rtv) result.returnTypeValidated = true;
  if (isExported) result.exported = true;
  if (isSafe) result.safe = true;

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


export const graphNodeParser: Parser<GraphNodeDefinition> = label("a node definition", withLoc(memo(
  "graphNodeParser",
  map(
    seqC(
      set("type", "graphNode"),
      capture(exportKeywordParser, "exported"),
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
      const { returnTypeValidated: _rtv, exported: _exp, ...rest } = result;
      if (_rtv) rest.returnTypeValidated = true;
      if (_exp) rest.exported = true;
      return rest;
    },
  ),
)));

// =============================================================================
// reserved `class` keyword detector
// =============================================================================
//
// Agency's `class Foo { ... }` definition syntax was removed. `new Foo()`
// expressions remain valid for instantiating JS classes imported from
// TypeScript. This parser detects a top-level `class Name` token sequence
// and commits to a fatal error pointing migrators at the new pattern.
//
// Why throw instead of returning `failure(...)`:
//   `nodeParser` is an `or(...)` of statement-level parsers. A plain
//   `failure(...)` from this parser would be shadowed by any sibling that
//   manages to consume more of the input (e.g. `valueAccessParser` will
//   happily parse `class` as an identifier and the user sees a confusing
//   downstream error). Once we see `class <whitespace+>`, the input is
//   unambiguously a class definition attempt — wrap with `parseError`
//   over an always-failing inner parser to throw a `TarsecError` that
//   bypasses `or()` backtracking entirely. `parseAgency` already catches
//   `TarsecError` and surfaces it as a normal parse diagnostic.
const RESERVED_CLASS_MESSAGE =
  "`class` definitions are no longer supported in Agency. " +
  "Use functions and plain objects instead, or instantiate an imported " +
  "JS class with `new Foo(...)`.";

export const reservedClassParser: Parser<never> = (input: string) => {
  // Probe: `class` followed by one-or-more space/tab and an identifier.
  // many1 of " \t" (not `space`, which is single, and not `spaces`, which
  // permits newlines) tolerates `class Foo`, `class  Foo`, `class\tFoo`
  // without firing on `class\nFoo` or treating `classify` as a hit.
  const probe = seqC(
    str("class"),
    many1(oneOf(" \t")),
    many1WithJoin(varNameChar),
  );
  if (!probe(input).success) {
    return failure("", input);
  }
  // Probe matched — commit to a fatal error. `fail(...)` always returns
  // a failed ParserResult, which makes `parseError` throw a `TarsecError`
  // carrying our actionable message. The cast is needed because
  // `parseError` is typed as `Parser<{}>` (it doesn't know its inner
  // parser always fails); the call never returns normally.
  return parseError(
    RESERVED_CLASS_MESSAGE,
    fail("class definition"),
  )(input) as ParserResult<never>;
};

// =============================================================================
// pattern.ts — destructuring + match patterns
// =============================================================================

export const wildcardPatternParser: Parser<WildcardPattern> = label(
  "a wildcard pattern",
  withLoc(seqC(set("type", "wildcardPattern"), char("_"), not(varNameChar))),
);

export const restPatternParser: Parser<RestPattern> = label(
  "a rest pattern",
  withLoc(
    seqC(
      set("type", "restPattern"),
      str("..."),
      capture(many1WithJoin(varNameChar), "identifier"),
    ),
  ),
);

// ---- helpers shared by binding and match array parsers ----

function enforceRestAtEnd<T extends { type: string }>(
  elements: readonly T[],
): void {
  for (let i = 0; i < elements.length - 1; i++) {
    if (elements[i].type === "restPattern") {
      // Throw to surface the message past surrounding `or` combinators,
      // which would otherwise swallow it as "all parsers failed".
      throw new Error(
        "rest pattern must be the last element of an array pattern",
      );
    }
  }
}

// ---- binding pattern parsers ----

const _bindingPatternParser: Parser<BindingPattern> = memo("bindingPatternParser", or(
  lazy(() => arrayBindingPatternParser),
  lazy(() => objectBindingPatternParser),
  restPatternParser,
  // wildcard MUST come before variableNameParser so `_` doesn't match as identifier
  wildcardPatternParser,
  variableNameParser,
) as Parser<BindingPattern>);
export const bindingPatternParser: Parser<BindingPattern> = _bindingPatternParser;

export const arrayBindingPatternParser: Parser<ArrayPattern> = label(
  "an array binding pattern",
  (input: string): ParserResult<ArrayPattern> => {
    const parser = withLoc(
      seqC(
        set("type", "arrayPattern"),
        char("["),
        optionalSpacesOrNewline,
        capture(
          or(
            sepBy(commaWithNewline, lazy(() => bindingPatternParser)),
            succeed([]),
          ),
          "elements",
        ),
        optionalSpacesOrNewline,
        char("]"),
      ),
    );
    const result = parser(input);
    if (!result.success) return result;
    enforceRestAtEnd(result.result.elements);
    return result;
  },
);

const _objectPatternShorthandParser: Parser<ObjectPatternShorthand> = (
  input: string,
) => {
  const r = variableNameParser(input);
  if (!r.success) return r;
  return success(
    { type: "objectPatternShorthand" as const, name: r.result.value },
    r.rest,
  );
};

// Shared helpers for binding and match object-property parsers. The two
// only differ by the inner value parser (bindingPatternParser vs
// matchPatternParser); ObjectPatternProperty["value"] (= MatchPattern)
// covers both, so we factor out the shape.
const propertyWithValueParser = (
  valueParser: Parser<MatchPattern>,
): Parser<ObjectPatternProperty> => (input: string) => {
  const parser = seqC(
    set("type", "objectPatternProperty"),
    capture(many1WithJoin(varNameChar), "key"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(valueParser, "value"),
  );
  return parser(input);
};

const objectPatternPropertyParser = (
  valueParser: Parser<MatchPattern>,
): Parser<ObjectPatternProperty | ObjectPatternShorthand | RestPattern> =>
  or(
    restPatternParser,
    // propertyWithValue MUST be tried before shorthand — the ':' disambiguates
    propertyWithValueParser(valueParser),
    _objectPatternShorthandParser,
  );

const _bindingObjectPropertyParser: Parser<
  ObjectPatternProperty | ObjectPatternShorthand | RestPattern
> = objectPatternPropertyParser(lazy(() => bindingPatternParser));

export const objectBindingPatternParser: Parser<ObjectPattern> = label(
  "an object binding pattern",
  withLoc(
    seqC(
      set("type", "objectPattern"),
      char("{"),
      optionalSpacesOrNewline,
      capture(
        or(
          sepBy(commaWithNewline, _bindingObjectPropertyParser),
          succeed([]),
        ),
        "properties",
      ),
      optionalSpacesOrNewline,
      char("}"),
    ),
  ),
);

// ---- match pattern parsers ----

// Result patterns: `success`, `success(v)`, `failure`, `failure(e)`. Must be
// placed in `_matchPatternParser` BEFORE `variableNameParser`, so `success`
// and `failure` in pattern position are intercepted before they'd parse as
// bare variable names. In expression position, `success(42)` etc. remain
// valid function calls because expression parsers do not use this parser.
type ResultPatternBase = {
  type: "resultPattern";
  kind: "success" | "failure";
  binding: string | null;
};

export const resultPatternParser: Parser<ResultPattern> = withLoc(
  (input: string): ParserResult<ResultPatternBase> => {
    // Try "success" or "failure" keyword + identifier boundary so `successful`
    // does NOT match. A soft failure here lets the outer `or` fall through to
    // `variableNameParser`.
    const kwResult = or(str("success"), str("failure"))(input);
    if (!kwResult.success) return kwResult;
    const kind = kwResult.result as "success" | "failure";
    const boundary = not(varNameChar)(kwResult.rest);
    if (!boundary.success) {
      return fail("not a result pattern keyword boundary")(input);
    }

    // Bare form: no `(` after the keyword.
    if (kwResult.rest[0] !== "(") {
      return success(
        { type: "resultPattern", kind, binding: null },
        kwResult.rest,
      );
    }

    // Committed to the result-pattern form: once we see `success(` or
    // `failure(`, the next token MUST be an identifier followed by `)`.
    // `parseError` runs the wrapped sequence and throws on failure, which
    // bypasses the surrounding `or` in `_matchPatternParser` — without this,
    // `success()` would silently fall through to `variableNameParser`
    // (parsing `success` as a bare identifier and leaving `()` as remainder).
    const bindingResult = parseError(
      `expected an identifier in result pattern binding (e.g. \`${kind}(name)\`); empty parens and non-identifier expressions are not allowed`,
      char("("),
      optionalSpacesOrNewline,
      capture(variableNameParser, "binding"),
      optionalSpacesOrNewline,
      char(")"),
    )(kwResult.rest);
    if (!bindingResult.success) return bindingResult;
    return success(
      {
        type: "resultPattern",
        kind,
        binding: (bindingResult.result.binding as { value: string }).value,
      },
      bindingResult.rest,
    );
  },
);

const _matchPatternParser = (input: string): ParserResult<MatchPattern> => {
  // NOTE: cannot reuse simpleLiteralParser directly because it tries
  // numberParser before variableNameParser, and numberParser is greedy on `_`
  // (e.g. `_foo` would parse as `{type: "number", value: ""}` with rest `foo`).
  // We must place variableNameParser before numberParser here.
  const parser = or(
    lazy(() => arrayMatchPatternParser),
    lazy(() => objectMatchPatternParser),
    restPatternParser,
    // wildcard MUST come before variableNameParser so `_` doesn't match as identifier
    wildcardPatternParser,
    nullParser,
    booleanParser,
    unitLiteralParser,
    // resultPatternParser MUST come before variableNameParser so `success` /
    // `failure` are intercepted before they'd parse as bare identifiers.
    resultPatternParser,
    variableNameParser,
    numberParser,
    _stringParser,
  );
  return parser(input) as ParserResult<MatchPattern>;
};
export const matchPatternParser: Parser<MatchPattern> = _matchPatternParser;

export const arrayMatchPatternParser: Parser<ArrayPattern> = label(
  "an array match pattern",
  (input: string): ParserResult<ArrayPattern> => {
    const parser = withLoc(
      seqC(
        set("type", "arrayPattern"),
        char("["),
        optionalSpacesOrNewline,
        capture(
          or(
            sepBy(commaWithNewline, lazy(() => matchPatternParser)),
            succeed([]),
          ),
          "elements",
        ),
        optionalSpacesOrNewline,
        char("]"),
      ),
    );
    const result = parser(input);
    if (!result.success) return result;
    enforceRestAtEnd(result.result.elements);
    return result;
  },
);

const _matchObjectPropertyParser: Parser<
  ObjectPatternProperty | ObjectPatternShorthand | RestPattern
> = objectPatternPropertyParser(lazy(() => matchPatternParser));

export const objectMatchPatternParser: Parser<ObjectPattern> = label(
  "an object match pattern",
  withLoc(
    seqC(
      set("type", "objectPattern"),
      char("{"),
      optionalSpacesOrNewline,
      capture(
        or(
          sepBy(commaWithNewline, _matchObjectPropertyParser),
          succeed([]),
        ),
        "properties",
      ),
      optionalSpacesOrNewline,
      char("}"),
    ),
  ),
);
