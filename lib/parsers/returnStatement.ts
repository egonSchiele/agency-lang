import { capture, or, Parser, seqC, set, str } from "tarsec";
import { ReturnStatement } from "../types/returnStatement.js";
import { valueAccessParser } from "./access.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import {
  llmPromptFunctionCallParser,
  streamingPromptLiteralParser,
} from "./functionCall.js";
import { booleanParser, literalParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces } from "./utils.js";
import { binOpParser } from "./binop.js";

export const returnStatementParser: Parser<ReturnStatement> = seqC(
  set("type", "returnStatement"),
  str("return"),
  optionalSpaces,
  capture(
    or(
      streamingPromptLiteralParser,
      binOpParser,
      llmPromptFunctionCallParser,
      booleanParser,
      valueAccessParser,
      literalParser,
      agencyObjectParser,
      agencyArrayParser,
    ),
    "value",
  ),
  optionalSemicolon,
);
