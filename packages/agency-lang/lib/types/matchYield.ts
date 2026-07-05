import { Expression } from "../types.js";
import { BaseNode } from "./base.js";

/** Internal node produced by pattern lowering for `return` inside a match arm
 *  when the match is used as an expression. Never produced by the parser. */
export type MatchYield = BaseNode & {
  type: "matchYield";
  matchId: number;
  value?: Expression;
  /** For a single-expression arm hoisted to a temp so the value flows through
   *  statement-position interrupt propagation (#430), `value` is the temp ref
   *  (`__armval_N`) — correct for codegen but too coarse for typing, which
   *  needs the arm's real expression to preserve literal types and per-arm
   *  discriminant narrowing. This holds that original expression; the type
   *  checker synthesizes the arm's type from it instead of the temp ref. */
  typeSource?: Expression;
};
