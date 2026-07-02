import { AgencyComment, AgencyNode, Expression, NewLine } from "../types.js";
import { BaseNode } from "./base.js";
import { IsExpression, MatchPattern } from "./pattern.js";

export type DefaultCase = "_";

export type MatchBlockCase = {
  type: "matchBlockCase";
  caseValue: MatchPattern | DefaultCase;
  guard?: Expression;
  body: AgencyNode[];
};

export type MatchBlock = BaseNode & {
  type: "matchBlock";
  expression: Expression | IsExpression;
  cases: (MatchBlockCase | AgencyComment | NewLine)[];
  /** Set by pattern lowering when this match is used as an expression: the id
   *  the lowered `runner.ifElse` OWNS, so `matchYield` unwinds are consumed
   *  here. Undefined for statement-position matches (no drift in codegen). */
  matchExprId?: number;
};

/** Slim, lowering-preserved metadata for a single match arm: just the matcher
 *  pattern and optional guard, with the body dropped. A deep-cloned array of
 *  these is carried on the lowered scrutinee `Assignment` as `matchSource` (see
 *  there) so a later type-checker pass can recover the arm structure without
 *  retaining or aliasing the un-lowered case bodies. */
export type MatchArmMeta = {
  caseValue: MatchPattern | DefaultCase;
  guard?: Expression;
};
