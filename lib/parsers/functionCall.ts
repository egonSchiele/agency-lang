import { FunctionCall } from "@/types";
import {
  seqR,
  char,
  Parser,
  seqC,
  set,
  capture,
  many1WithJoin,
  alphanum,
  sepBy,
} from "tarsec";
import { literalParser } from "./literals";
import { optionalSpaces } from "./utils";

const comma = seqR(optionalSpaces, char(","), optionalSpaces);
export const functionCallParser: Parser<FunctionCall> = seqC(
  set("type", "functionCall"),
  capture(many1WithJoin(alphanum), "functionName"),
  char("("),
  optionalSpaces,
  capture(sepBy(comma, literalParser), "arguments"),
  optionalSpaces,
  char(")")
);
