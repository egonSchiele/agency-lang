import { Assignment } from "@/types";
import {
  capture,
  char,
  many1Till,
  or,
  Parser,
  seqC,
  set,
  space,
  trace,
} from "tarsec";
import { literalParser } from "./literals";
import { optionalSpaces } from "./utils";

export const assignmentParser: Parser<Assignment> = trace(
  "assignmentParser",
  seqC(
    set("type", "assignment"),
    optionalSpaces,
    capture(many1Till(or(space, char("="))), "variableName"),
    optionalSpaces,
    char("="),
    optionalSpaces,
    capture(literalParser, "value")
  )
);
