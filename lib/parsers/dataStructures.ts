import { ADLArray, ADLObject, ADLObjectKV } from "@/types/dataStructures";
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
  trace,
} from "tarsec";
import { accessExpressionParser } from "./access";
import { functionCallParser } from "./functionCall";
import { literalParser } from "./literals";
import { comma, optionalSpaces } from "./utils";

export const adlArrayParser: Parser<ADLArray> = (
  input: string
): ParserResult<ADLArray> => {
  const parser = trace(
    "adlArrayParser",
    seqC(
      set("type", "adlArray"),
      char("["),
      capture(
        sepBy(
          comma,
          or(
            accessExpressionParser,
            functionCallParser,
            literalParser,
            adlObjectParser,
            adlArrayParser
          )
        ),
        "items"
      ),

      char("]")
    )
  );

  return parser(input);
};

export const adlObjectKVParser: Parser<ADLObjectKV> = (
  input: string
): ParserResult<ADLObjectKV> => {
  const parser = trace(
    "adlObjectKVParser",
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
          adlObjectParser,
          adlArrayParser
        ),
        "value"
      )
    )
  );

  return parser(input);
};

export const adlObjectParser: Parser<ADLObject> = seqC(
  set("type", "adlObject"),
  char("{"),
  optionalSpaces,
  capture(sepBy(comma, adlObjectKVParser), "entries"),
  optional(char(",")),
  optionalSpaces,
  char("}")
);
