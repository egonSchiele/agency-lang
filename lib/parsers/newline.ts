import { NewLine } from "@/types.js";
import { or, Parser, seqC, set, str } from "tarsec";

export const newLineParser: Parser<NewLine> = seqC(
  set("type", "newLine"),
  or(str("\r\n"), str("\n")),
);
