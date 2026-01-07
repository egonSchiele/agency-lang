import { backtick, varNameChar } from "./utils.js";
import {
  InterpolationSegment,
  Literal,
  NumberLiteral,
  PromptLiteral,
  StringLiteral,
  TextSegment,
  VariableNameLiteral,
} from "../types.js";
import {
  Parser,
  capture,
  char,
  digit,
  many,
  many1Till,
  many1WithJoin,
  manyTill,
  map,
  or,
  seqC,
  set,
} from "tarsec";

export const textSegmentParser: Parser<TextSegment> = map(
  many1Till(or(backtick, char("$"))),
  (text) => ({
    type: "text",
    value: text,
  })
);

export const interpolationSegmentParser: Parser<InterpolationSegment> = seqC(
  set("type", "interpolation"),
  char("$"),
  char("{"),
  capture(many1Till(char("}")), "variableName"),
  char("}")
);

export const promptParser: Parser<PromptLiteral> = seqC(
  set("type", "prompt"),
  backtick,
  capture(many(or(textSegmentParser, interpolationSegmentParser)), "segments"),
  backtick
);
export const numberParser: Parser<NumberLiteral> = seqC(
  set("type", "number"),
  capture(many1WithJoin(or(char("-"), char("."), digit)), "value")
);
export const stringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  char('"'),
  capture(manyTill(char('"')), "value"),
  char('"')
);
export const variableNameParser: Parser<VariableNameLiteral> = seqC(
  set("type", "variableName"),
  capture(many1WithJoin(varNameChar), "value")
);

export const literalParser: Parser<Literal> = or(
  promptParser,
  numberParser,
  stringParser,
  variableNameParser
);
