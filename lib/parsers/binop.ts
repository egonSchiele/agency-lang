import { BinOpExpression, Operator } from "@/types/binop.js";
import { capture, oneOf, or, Parser, seqC, set, str, trace } from "tarsec";
import { valueAccessParser } from "./access.js";
import { booleanParser, simpleLiteralParser } from "./literals.js";
import { oneOfStr, optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces } from "./utils.js";

export const binOpParser: Parser<BinOpExpression> = (input: string) => {
  const parser = trace(
    "binOpParser",
    seqC(
      set("type", "binOpExpression"),
      capture(or(booleanParser, valueAccessParser, simpleLiteralParser), "left"),
      optionalSpaces,
      capture(
        oneOfStr(["==", "!=", "+=", "-=", "*=", "/=", "<=", ">=", "+", "-", "*", "/", "<", ">"] as Operator[]),
        "operator",
      ),
      optionalSpaces,
      capture(or(booleanParser, valueAccessParser, simpleLiteralParser), "right"),
      optionalSemicolon,
    ),
  );
  return parser(input);
};
