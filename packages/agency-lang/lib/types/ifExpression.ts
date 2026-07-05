import { BaseNode } from "./base.js";
import type { Expression } from "../types.js";

/**
 * `if <condition> then <thenExpr> else <elseExpr>` — a conditional *expression*
 * (Agency's readable alternative to a ternary). Unlike an `if` statement it is a
 * plain value: it appears anywhere an expression can (assignment RHS, `return`,
 * object values, arguments) and compiles to a TS conditional
 * `condition ? thenExpr : elseExpr`.
 *
 * Deliberately 2-way and NON-nestable: none of `condition` / `thenExpr` /
 * `elseExpr` may itself be an `ifExpression` (which also rules out `else if`
 * chains). For multi-way or nested branching, use `match`. `else` is mandatory
 * by construction, so the expression always produces a value.
 */
export type IfExpression = BaseNode & {
  type: "ifExpression";
  condition: Expression;
  thenExpr: Expression;
  elseExpr: Expression;
};
