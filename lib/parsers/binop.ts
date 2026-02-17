import { BinOpExpression, Operator } from "@/types/binop.js";
import { capture, oneOf, or, Parser, seqC, set, str, trace } from "tarsec";
import { simpleLiteralParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces } from "./utils.js";

export const binOpParser: Parser<BinOpExpression> = (input: string) => {
  const parser = trace(
    "binOpParser",
    seqC(
      set("type", "binOpExpression"),
      capture(simpleLiteralParser, "left"),
      optionalSpaces,
      capture(
        or(
          str("=="),
          str("!="),
          str("<="),
          str(">="),
          oneOf("+-*/<>"),
        ) as Parser<Operator>,
        "operator",
      ),
      optionalSpaces,
      capture(simpleLiteralParser, "right"),
      optionalSemicolon,
    ),
  );
  return parser(input);
};
