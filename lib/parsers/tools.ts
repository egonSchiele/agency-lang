import { UsesTool } from "../types/tools.js";
import { capture, char, many1WithJoin, Parser, seqC, set } from "tarsec";
import { varNameChar } from "./utils.js";

export const usesToolParser: Parser<UsesTool> = seqC(
  set("type", "usesTool"),
  char("+"),
  capture(many1WithJoin(varNameChar), "toolName")
);
