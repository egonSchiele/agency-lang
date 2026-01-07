import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
} from "@/types/dataStructures";
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
import { accessExpressionParser } from "./access";
import { functionCallParser } from "./functionCall";
import { literalParser } from "./literals";
import { comma, optionalSpaces } from "./utils";

export const agencyArrayParser: Parser<AgencyArray> = (
  input: string
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
            accessExpressionParser,
            functionCallParser,
            literalParser,
            agencyObjectParser,
            agencyArrayParser
          )
        ),
        "items"
      ),

      char("]")
    )
  );

  return parser(input);
};

export const agencyObjectKVParser: Parser<AgencyObjectKV> = (
  input: string
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
          accessExpressionParser,
          functionCallParser,
          literalParser,
          agencyObjectParser,
          agencyArrayParser
        ),
        "value"
      )
    )
  );

  return parser(input);
};

export const agencyObjectParser: Parser<AgencyObject> = seqC(
  set("type", "agencyObject"),
  char("{"),
  optionalSpaces,
  capture(or(sepBy(comma, agencyObjectKVParser), succeed([])), "entries"),
  optional(char(",")),
  optionalSpaces,
  char("}")
);
