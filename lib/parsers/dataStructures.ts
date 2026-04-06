import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
  SplatExpression,
} from "../types/dataStructures.js";
import {
  capture,
  char,
  lazy,
  many1WithJoin,
  manyWithJoin,
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
import { exprParser } from "./expression.js";
import {
  comma,
  commaWithNewline,
  optionalSpaces,
  optionalSpacesOrNewline,
  varNameChar,
} from "./utils.js";

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
