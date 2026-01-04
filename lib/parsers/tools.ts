import { UsesTool } from "@/types/tools";
import { capture, char, many1WithJoin, Parser, seqC, set } from "tarsec";
import { varNameChar } from "./utils";

export const usesToolParser: Parser<UsesTool> = seqC(
  set("type", "usesTool"),
  char("+"),
  capture(many1WithJoin(varNameChar), "toolName")
);
