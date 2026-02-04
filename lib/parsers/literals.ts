import {
  backtick,
  comma,
  commaWithNewline,
  optionalSpaces,
  optionalSpacesOrNewline,
  varNameChar,
} from "./utils.js";
import {
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
export const stringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  char('"'),
  capture(
    many(or(stringTextSegmentParser, interpolationSegmentParser)),
    "segments",
  ),
  char('"'),
);
export const multiLineStringParser: Parser<MultiLineStringLiteral> = seqC(
  set("type", "multiLineString"),
  str('"""'),
  capture(
    many(or(multiLineStringTextSegmentParser, interpolationSegmentParser)),
    "segments",
  ),
  str('"""'),
);

export const variableNameParser: Parser<VariableNameLiteral> = seq(
  [
    set("type", "variableName"),
    capture(letter, "init"),
    capture(manyWithJoin(varNameChar), "value"),
  ],
  (_, captures) => {
    return {
      type: "variableName",
      value: `${captures.init}${captures.value}`,
    };
  },
);

export const literalParser: Parser<Literal> = or(
  promptParser,
  numberParser,
  multiLineStringParser,
  stringParser,
  variableNameParser,
);
