import { BinOpExpression } from "@/types/binop.js";
import { failure, Parser, success } from "tarsec";
import { exprParser } from "./expression.js";
import { optionalSemicolon } from "./parserUtils.js";

// binOpParser now delegates to the unified expression parser.
// It only succeeds if the result is a BinOpExpression (not just an atom),
// preserving the original behavior for callers like bodyParser and agencyNode
// that list binOpParser as one of many alternatives.
export const binOpParser: Parser<BinOpExpression> = (input: string) => {
  const result = exprParser(input);
  if (!result.success) return result;

  if (result.result.type !== "binOpExpression") {
    return failure("expected binary expression", input);
  }

  // Consume optional trailing semicolon
  const semiResult = optionalSemicolon(result.rest);
  const finalRest = semiResult.success ? semiResult.rest : result.rest;
  return success(result.result as BinOpExpression, finalRest);
};
