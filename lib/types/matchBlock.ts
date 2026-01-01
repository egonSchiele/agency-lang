import { Assignment, AwaitStatement, FunctionCall } from "@/types";
import { Literal } from "./literals";
import { AccessExpression } from "./access";

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
