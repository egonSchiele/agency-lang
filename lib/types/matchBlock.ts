import { Assignment, FunctionCall } from "@/types";
import { AccessExpression } from "./access";
import { Literal } from "./literals";

export type DefaultCase = "_";

export type MatchBlockCase = {
  caseValue: AccessExpression | Literal | DefaultCase;
  body: Assignment | Literal | FunctionCall;
};

export type MatchBlock = {
  type: "matchBlock";
  expression: Literal;
  cases: MatchBlockCase[];
};
