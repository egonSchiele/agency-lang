import { trace } from "console";
import {
  Parser,
  map,
  many1Till,
  or,
  char,
  seqC,
  set,
  capture,
  many,
  many1WithJoin,
  digit,
  manyTill,
  alphanum,
} from "tarsec";
import {
  TextSegment,
  InterpolationSegment,
  PromptLiteral,
  NumberLiteral,
  StringLiteral,
  VariableNameLiteral,
  Literal,
} from "@/types";
import { backtick } from "@/parsers/utils";
import { awaitStatementParser } from "@/parser";

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
  capture(many1WithJoin(alphanum), "value")
);

export const literalParser: Parser<Literal> = or(
  awaitStatementParser,
  promptParser,
  numberParser,
  stringParser,
  variableNameParser
);
