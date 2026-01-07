import { WhileLoop } from "@/types/whileLoop";
import {
  between1,
  capture,
  char,
  or,
  Parser,
  seqC,
  set,
  spaces,
  str,
  trace,
} from "tarsec";
import { optionalSpaces } from "./utils";
import { functionCallParser } from "./functionCall";
import { accessExpressionParser } from "./access";
import { literalParser } from "./literals";
import { bodyParser } from "./body";

export const whileLoopParser: Parser<WhileLoop> = trace(
  "whileLoopParser",
  seqC(
    set("type", "whileLoop"),
    str("while"),
    optionalSpaces,
    char("("),
    optionalSpaces,
    capture(
      or(functionCallParser, accessExpressionParser, literalParser),
      "condition"
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    char("{"),
    spaces,
    capture(bodyParser, "body"),
    optionalSpaces,
    char("}")
  )
);
