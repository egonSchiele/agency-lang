import {
  backtick,
  comma,
  commaWithNewline,
  optionalSpaces,
  optionalSpacesOrNewline,
  plusSign,
  varNameChar,
} from "./utils.js";
import {
  BooleanLiteral,
  InterpolationSegment,
  Literal,
  MultiLineStringLiteral,
  NumberLiteral,
  PromptLiteral,
  StringLiteral,
  TextSegment,
  VariableNameLiteral,
} from "../types.js";
import {
  Parser,
  ParserResult,
  capture,
  char,
  digit,
  letter,
  many,
  many1Till,
  many1WithJoin,
  manyTill,
  manyTillOneOf,
  manyTillStr,
  manyWithJoin,
  map,
  noneOf,
  optional,
  or,
  sepBy,
  seq,
  seqC,
  set,
  succeed,
  str,
  trace,
  sepBy1,
  failure,
  success,
} from "tarsec";
import { indexAccessParser } from "./access.js";

export const textSegmentParser: Parser<TextSegment> = map(
  many1Till(or(backtick, char("$"))),
  (text) => ({
    type: "text",
    value: text,
  }),
);

export const stringTextSegmentParser: Parser<TextSegment> = map(
  many1Till(or(char('"'), char("$"))),
  (text) => ({
    type: "text",
    value: text,
  }),
);

export const multiLineStringTextSegmentParser: Parser<TextSegment> = map(
  many1Till(or(str('"""'), char("$"))),
  (text) => ({
    type: "text",
    value: text,
  }),
);

export const interpolationSegmentParser: Parser<InterpolationSegment> = seqC(
  set("type", "interpolation"),
  char("$"),
  char("{"),
  capture(manyTillStr("}"), "variableName"),
  char("}"),
);

export const promptParserBackticks: Parser<PromptLiteral> = seqC(
  set("type", "prompt"),
  backtick,
  capture(many(or(textSegmentParser, interpolationSegmentParser)), "segments"),
  backtick,
);

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
        // arrayParser,
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

/* export const promptParserLlmFunctionWithConfig: Parser<PromptLiteral> = (
  input: string,
) => {
  const parser = seqC(
    set("type", "prompt"),
    str("llm("),
    optionalSpaces,
    capture(
      map(stringParser, (str) => str.segments),
      "segments",
    ),
    optionalSpaces,
    char(","),
    capture(objectParser, "config"),
    optionalSpaces,
    char(")"),
  );
  return parser(input);
};

export const promptParserLlmFunction: Parser<PromptLiteral> = (
  input: string,
) => {
  const parser = seqC(
    set("type", "prompt"),
    str("llm("),
    optionalSpaces,
    capture(
      map(stringParser, (str) => str.segments),
      "segments",
    ),
    optionalSpaces,
    char(")"),
  );
  return parser(input);
};
 */
export const promptParser: Parser<PromptLiteral> = promptParserBackticks; /* or(
  promptParserBackticks,
  promptParserLlmFunctionWithConfig,
  promptParserLlmFunction,
); */

export const numberParser: Parser<NumberLiteral> = seqC(
  set("type", "number"),
  capture(many1WithJoin(or(char("-"), char("."), digit)), "value"),
);
export const _stringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  char('"'),
  capture(
    many(or(stringTextSegmentParser, interpolationSegmentParser)),
    "segments",
  ),
  char('"'),
);

export const stringParser: Parser<StringLiteral> = (input: string) => {
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
        variableName: part.value,
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
};

export const multiLineStringParser: Parser<MultiLineStringLiteral> = seqC(
  set("type", "multiLineString"),
  str('"""'),
  capture(
    many(or(multiLineStringTextSegmentParser, interpolationSegmentParser)),
    "segments",
  ),
  str('"""'),
);

export const variableNameParser: Parser<VariableNameLiteral> = (
  input: string,
) => {
  const parser = seq(
    [
      set("type", "variableName"),
      capture(letter, "init"),
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
};

export const booleanParser: Parser<BooleanLiteral> = seqC(
  set("type", "boolean"),
  capture(
    or(
      map(str("true"), () => true),
      map(str("false"), () => false),
    ),
    "value",
  ),
);

export const literalParser: Parser<Literal> = or(
  booleanParser,
  promptParser,
  numberParser,
  multiLineStringParser,
  stringParser,
  variableNameParser,
);
