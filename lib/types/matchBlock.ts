import { Assignment, AgencyComment } from "@/types";
import { AccessExpression } from "./access";
import { Literal } from "./literals";
import { FunctionCall } from "./function";
import { AgencyArray, AgencyObject } from "./dataStructures";
import { ReturnStatement } from "./returnStatement";

export type DefaultCase = "_";

export type MatchBlockCase = {
  type: "matchBlockCase";
  caseValue: AccessExpression | Literal | DefaultCase;
  body:
    | Assignment
    | Literal
    | FunctionCall
    | AccessExpression
    | AgencyArray
    | AgencyObject
    | ReturnStatement;
};

export type MatchBlock = {
  type: "matchBlock";
  expression: Literal;
  cases: (MatchBlockCase | AgencyComment)[];
};
