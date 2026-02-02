import { NewLine } from "@/types.js";
import { Parser, seqC, set, str } from "tarsec";

export const newLineParser: Parser<NewLine> = seqC(
  set("type", "newLine"),
  str("\n"),
);
