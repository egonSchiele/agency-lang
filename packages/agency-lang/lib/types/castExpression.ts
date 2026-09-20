import { BaseNode } from "./base.js";
import { Expression } from "../types.js";
import { VariableType } from "./typeHints.js";

/** `expr as Type`, or `expr as Type!` when `checked`. */
export type CastExpression = BaseNode & {
  type: "castExpression";
  expression: Expression;
  targetType: VariableType;
  checked: boolean;
  /** Set by the parser when parentheses directly wrap this cast. Read by
   *  the refused-position check; `a + (b as T)` is allowed, `a + b as T` is not. */
  parenthesized?: boolean;
};
