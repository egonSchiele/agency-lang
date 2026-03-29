import { capture, captureCaptures, parseError, Parser, seqC, set, str } from "tarsec";
import { ReturnStatement } from "../types/returnStatement.js";
import { exprParser } from "./expression.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces } from "./utils.js";

export const returnStatementParser: Parser<ReturnStatement> = seqC(
  set("type", "returnStatement"),
  str("return"),
  captureCaptures(
    parseError(
      "expected a return value (expression, prompt, or literal)",
      optionalSpaces,
      capture(
        exprParser,
        "value",
      ),
      optionalSemicolon,
    ),
  ),
);
