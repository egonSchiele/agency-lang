import { backtick, varNameChar } from "./utils.js";
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
  or,
  seq,
  seqC,
  set,
  str,
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
  capture(manyTillStr("}"), "variableName"),
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
  capture(manyTillOneOf(['"', "\n"]), "value"),
  char('"')
);
export const multiLineStringParser: Parser<MultiLineStringLiteral> = seqC(
  set("type", "multiLineString"),
  str('"""'),
  capture(manyTillStr('"""'), "value"),
  str('"""')
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
  }
);

export const literalParser: Parser<Literal> = or(
  promptParser,
  numberParser,
  multiLineStringParser,
  stringParser,
  variableNameParser
);
