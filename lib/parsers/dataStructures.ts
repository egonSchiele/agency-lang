import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
  SplatExpression,
} from "../types/dataStructures.js";
import {
  capture,
  char,
  manyWithJoin,
  noneOf,
  optional,
  or,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  set,
  str,
  succeed,
  trace,
} from "tarsec";
import { valueAccessParser } from "./access.js";
import { booleanParser, literalParser } from "./literals.js";
import {
  comma,
  commaWithNewline,
  optionalSpaces,
  optionalSpacesOrNewline,
} from "./utils.js";

export const splatParser: Parser<SplatExpression> = seqC(
  set("type", "splat"),
  str("..."),
  capture(valueAccessParser, "value"),
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
            booleanParser,
            valueAccessParser,
            literalParser,
            agencyObjectParser,
            agencyArrayParser,
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
      capture(manyWithJoin(noneOf('":\n\t ')), "key"),
      optional(char('"')),
      optionalSpaces,
      char(":"),
      optionalSpaces,
      capture(
        or(
          booleanParser,
          valueAccessParser,
          literalParser,
          agencyObjectParser,
          agencyArrayParser,
        ),
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
