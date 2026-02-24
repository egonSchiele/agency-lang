import {
  BinOpArgument,
  BinOpExpression,
  Operator,
  PRECEDENCE,
} from "@/types/binop.js";
import { failure, or, Parser, ParserResult, success } from "tarsec";
import { valueAccessParser } from "./access.js";
import { booleanParser, simpleLiteralParser } from "./literals.js";
import { oneOfStr, optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces } from "./utils.js";

const operatorParser = oneOfStr([
  "==", "!=", "+=", "-=", "*=", "/=", "<=", ">=",
  "&&", "||",
  "+", "-", "*", "/", "<", ">",
] as Operator[]);

const baseAtomParser: Parser<BinOpArgument> = or(
  booleanParser,
  valueAccessParser,
  simpleLiteralParser,
);

function parseAtom(input: string): ParserResult<BinOpArgument> {
  return baseAtomParser(input);
}

function parseExprPrec(input: string, minPrec: number): ParserResult<BinOpArgument> {
  const atomResult = parseAtom(input);
  if (!atomResult.success) return atomResult;

  let left: BinOpArgument = atomResult.result;
  let rest = atomResult.rest;

  while (true) {
    // Try to parse optional spaces + operator + optional spaces
    const spacesBeforeOp = optionalSpaces(rest);
    const opRest = spacesBeforeOp.success ? spacesBeforeOp.rest : rest;

    const opResult = operatorParser(opRest);
    if (!opResult.success) break;

    const op = opResult.result as Operator;
    const prec = PRECEDENCE[op];
    if (prec === undefined || prec < minPrec) break;

    const spacesAfterOp = optionalSpaces(opResult.rest);
    const rightInput = spacesAfterOp.success ? spacesAfterOp.rest : opResult.rest;

    // Parse right side with higher min precedence (left-associative)
    const rightResult = parseExprPrec(rightInput, prec + 1);
    if (!rightResult.success) break;

    left = {
      type: "binOpExpression",
      operator: op,
      left,
      right: rightResult.result,
    };
    rest = rightResult.rest;
  }

  return success(left, rest);
}

export const binOpParser: Parser<BinOpExpression> = (input: string) => {
  const result = parseExprPrec(input, 0);
  if (!result.success) return result;

  // Only succeed if we actually parsed a binary expression (not just an atom)
  if (result.result.type === "binOpExpression") {
    // Consume optional trailing semicolon
    const semiResult = optionalSemicolon(result.rest);
    const finalRest = semiResult.success ? semiResult.rest : result.rest;
    return success(result.result as BinOpExpression, finalRest);
  }

  return failure("expected binary expression", input);
};
