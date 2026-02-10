import { UsesTool } from "../types/tools.js";
import {
  capture,
  char,
  many1WithJoin,
  or,
  Parser,
  sepBy,
  sepBy1,
  seqC,
  set,
  str,
} from "tarsec";
import { comma, varNameChar } from "./utils.js";

export const usesToolParser: Parser<UsesTool> = seqC(
  set("type", "usesTool"),
  or(str("uses "), str("use "), char("+")),
  capture(sepBy1(comma, many1WithJoin(varNameChar)), "toolNames"),
);
