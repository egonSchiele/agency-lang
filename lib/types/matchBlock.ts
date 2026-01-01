import { Assignment } from "@/types";
import { AccessExpression } from "./access";
import { Literal } from "./literals";
import { FunctionCall } from "./function";

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
