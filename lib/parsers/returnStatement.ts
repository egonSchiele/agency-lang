import { ReturnStatement } from "../types/returnStatement.js";
import { Parser, seqC, set, str, capture, or } from "tarsec";
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { functionCallParser } from "./functionCall.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces } from "./utils.js";
import { literalParser } from "./literals.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";

export const returnStatementParser: Parser<ReturnStatement> = seqC(
  set("type", "returnStatement"),
  str("return"),
  optionalSpaces,
  capture(
    or(
      indexAccessParser,
      accessExpressionParser,
      functionCallParser,
      literalParser,
      agencyObjectParser,
      agencyArrayParser
    ),
    "value"
  ),
  optionalSemicolon
);
