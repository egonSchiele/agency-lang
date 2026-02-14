import {
  capture,
  captureCaptures,
  char,
  many1WithJoin,
  or,
  parseError,
  Parser,
  sepBy1,
  seqC,
  set,
  str,
} from "tarsec";
import { UsesTool } from "../types/tools.js";
import { comma, varNameChar } from "./utils.js";

export const usesToolParser: Parser<UsesTool> = seqC(
  set("type", "usesTool"),
  or(str("uses "), str("use "), char("+")),
  captureCaptures(
    parseError(
      "expected one or more variable names separated by commas",
      capture(sepBy1(comma, many1WithJoin(varNameChar)), "toolNames"),
    ),
  ),
);
