import { ReturnStatement } from "../types/returnStatement.js";
import { Parser, seqC, set, str, capture, or } from "tarsec";
import { accessExpressionParser, indexAccessParser } from "./access.js";
import {
  asyncFunctionCallParser,
  functionCallParser,
  llmPromptFunctionCallParser,
  streamingPromptLiteralParser,
} from "./functionCall.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces } from "./utils.js";
import { literalParser } from "./literals.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { awaitParser } from "./await.js";

export const returnStatementParser: Parser<ReturnStatement> = seqC(
  set("type", "returnStatement"),
  str("return"),
  optionalSpaces,
  capture(
    or(
      awaitParser,
      asyncFunctionCallParser,
      streamingPromptLiteralParser,
      indexAccessParser,
      accessExpressionParser,
      llmPromptFunctionCallParser,
      functionCallParser,
      literalParser,
      agencyObjectParser,
      agencyArrayParser,
    ),
    "value",
  ),
  optionalSemicolon,
);
