import {
  buildExpressionParser,
  char,
  failure,
  lazy,
  or,
  Parser,
  str,
  success,
} from "tarsec";
import { Expression } from "../types.js";
import { BinOpExpression, Operator } from "../types/binop.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { booleanParser, literalParser } from "./literals.js";
import { valueAccessParser } from "./access.js";
import { optionalSpaces } from "./utils.js";

// --- Unary ! operator ---
// Desugared to BinOpExpression: !x → { op: "!", left: true, right: x }
// The builder must generate `!x`, not `true ! x`.
//
// Note: unary `-` is NOT included. Negative number literals like `-42` are
// already handled by numberParser in literals.ts. Adding unary `-` would
// create ambiguity where `-42` parses as `0 - 42`.
const unaryNotParser: Parser<Expression> = (input: string) => {
  const bangResult = char("!")(input);
  if (!bangResult.success) return bangResult;
  // Recurse to atom (not exprParser) so `!` binds tightly: `!x && y` = `(!x) && y`
  const atomResult = atom(bangResult.rest);
  if (!atomResult.success) return failure("expected expression after !", input);
  return success(
    {
      type: "binOpExpression" as const,
      operator: "!" as Operator,
      left: { type: "boolean" as const, value: true },
      right: atomResult.result,
    } as BinOpExpression,
    atomResult.rest,
  );
};

// The atom parser: the smallest unit of an expression.
// Sub-parsers are wrapped in lazy() to handle circular imports that will exist
// after Task 3 (e.g., functionCall.ts will import exprParser from this file,
// but this file imports valueAccessParser which comes from access.ts which
// imports from functionCall.ts). lazy() defers evaluation until parse time,
// when all modules are fully loaded.
const atom: Parser<Expression> = or(
  unaryNotParser,
  lazy(() => agencyArrayParser),
  lazy(() => agencyObjectParser),
  lazy(() => booleanParser),
  lazy(() => valueAccessParser),
  lazy(() => literalParser),
);

// Operator helper: parse an operator with optional surrounding whitespace
function wsOp(opStr: string): Parser<string> {
  return (input: string) => {
    const r1 = optionalSpaces(input);
    if (!r1.success) return r1;
    const r2 = str(opStr)(r1.rest);
    if (!r2.success) return r2;
    const r3 = optionalSpaces(r2.rest);
    if (!r3.success) return r3;
    return { success: true as const, result: opStr, rest: r3.rest };
  };
}

// Build a BinOpExpression AST node
function makeBinOp(op: string): (left: Expression, right: Expression) => Expression {
  return (left, right) => ({
    type: "binOpExpression" as const,
    operator: op as Operator,
    left,
    right,
  });
}

// Custom paren parser with whitespace handling.
// The default paren parser in buildExpressionParser does input[0] === "("
// with no whitespace skipping. This handles optional whitespace inside parens.
let _exprParser: Parser<Expression>;
const parenParser: Parser<Expression> = (input: string) => {
  const openResult = char("(")(input);
  if (!openResult.success) return openResult;
  const ws1 = optionalSpaces(openResult.rest);
  if (!ws1.success) return ws1;
  const exprResult = _exprParser(ws1.rest);
  if (!exprResult.success) return failure("expected expression inside parentheses", input);
  const ws2 = optionalSpaces(exprResult.rest);
  if (!ws2.success) return ws2;
  const closeResult = char(")")(ws2.rest);
  if (!closeResult.success) return failure("expected closing parenthesis", input);
  return success(exprResult.result, closeResult.rest);
};

// Operator table: highest precedence first.
// Multi-char operators must come before their single-char prefixes
// (e.g., *= before *, <= before <).
export const exprParser: Parser<Expression> = buildExpressionParser<Expression>(
  atom,
  [
    // Precedence 6: multiplicative (and *=, /=)
    [
      { op: wsOp("*="), assoc: "right" as const, apply: makeBinOp("*=") },
      { op: wsOp("/="), assoc: "right" as const, apply: makeBinOp("/=") },
      { op: wsOp("*"), assoc: "left" as const, apply: makeBinOp("*") },
      { op: wsOp("/"), assoc: "left" as const, apply: makeBinOp("/") },
    ],
    // Precedence 5: additive (and +=, -=)
    [
      { op: wsOp("+="), assoc: "right" as const, apply: makeBinOp("+=") },
      { op: wsOp("-="), assoc: "right" as const, apply: makeBinOp("-=") },
      { op: wsOp("+"), assoc: "left" as const, apply: makeBinOp("+") },
      { op: wsOp("-"), assoc: "left" as const, apply: makeBinOp("-") },
    ],
    // Precedence 4: relational
    [
      { op: wsOp("<="), assoc: "left" as const, apply: makeBinOp("<=") },
      { op: wsOp(">="), assoc: "left" as const, apply: makeBinOp(">=") },
      { op: wsOp("<"), assoc: "left" as const, apply: makeBinOp("<") },
      { op: wsOp(">"), assoc: "left" as const, apply: makeBinOp(">") },
    ],
    // Precedence 3: equality
    [
      { op: wsOp("=="), assoc: "left" as const, apply: makeBinOp("==") },
      { op: wsOp("!="), assoc: "left" as const, apply: makeBinOp("!=") },
    ],
    // Precedence 2: logical AND
    [
      { op: wsOp("&&"), assoc: "left" as const, apply: makeBinOp("&&") },
    ],
    // Precedence 1: logical OR
    [
      { op: wsOp("||"), assoc: "left" as const, apply: makeBinOp("||") },
    ],
  ],
  parenParser,
);

// Wire up the circular reference for parenParser
_exprParser = exprParser;
