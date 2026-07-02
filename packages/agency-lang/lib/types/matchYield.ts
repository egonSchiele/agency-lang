import { Expression } from "../types.js";
import { BaseNode } from "./base.js";

/** Internal node produced by pattern lowering for `return` inside a match arm
 *  when the match is used as an expression. Never produced by the parser. */
export type MatchYield = BaseNode & {
  type: "matchYield";
  matchId: number;
  value?: Expression;
};
