import { Assignment, AgencyComment, Expression, NewLine } from "../types.js";
import { BaseNode } from "./base.js";
import { IsExpression, MatchPattern } from "./pattern.js";
import { ReturnStatement } from "./returnStatement.js";

export type DefaultCase = "_";

export type MatchBlockCase = {
  type: "matchBlockCase";
  caseValue: MatchPattern | DefaultCase;
  guard?: Expression;
  body: Expression | Assignment | ReturnStatement;
};

export type MatchBlock = BaseNode & {
  type: "matchBlock";
  expression: Expression | IsExpression;
  cases: (MatchBlockCase | AgencyComment | NewLine)[];
};
