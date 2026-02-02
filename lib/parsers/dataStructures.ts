import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
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
  succeed,
  trace,
} from "tarsec";
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { functionCallParser } from "./functionCall.js";
import { literalParser } from "./literals.js";
import { comma, optionalSpaces, optionalSpacesOrNewline } from "./utils.js";

export const agencyArrayParser: Parser<AgencyArray> = (
  input: string,
): ParserResult<AgencyArray> => {
  const parser = trace(
    "agencyArrayParser",
    seqC(
      set("type", "agencyArray"),
      char("["),
      capture(
        sepBy(
          comma,
          or(
            indexAccessParser,
            accessExpressionParser,
            functionCallParser,
            literalParser,
            agencyObjectParser,
            agencyArrayParser,
          ),
        ),
        "items",
      ),

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
          indexAccessParser,
          accessExpressionParser,
          functionCallParser,
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
  capture(or(sepBy(comma, agencyObjectKVParser), succeed([])), "entries"),
  optional(char(",")),
  optionalSpacesOrNewline,
  char("}"),
);
