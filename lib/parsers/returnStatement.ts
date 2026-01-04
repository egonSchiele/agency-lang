import { ReturnStatement } from "@/types/returnStatement";
import { Parser, seqC, set, str, capture, or } from "tarsec";
import { accessExpressionParser } from "./access";
import { functionCallParser } from "./functionCall";
import { optionalSemicolon } from "./parserUtils";
import { optionalSpaces } from "./utils";
import { literalParser } from "./literals";
import { adlArrayParser, adlObjectParser } from "./dataStructures";

export const returnStatementParser: Parser<ReturnStatement> = seqC(
  set("type", "returnStatement"),
  str("return"),
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
  ),
  optionalSemicolon
);
