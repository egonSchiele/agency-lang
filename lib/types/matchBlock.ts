import { Assignment, AgencyComment } from "../types.js";
import { AccessExpression } from "./access.js";
import { Literal } from "./literals.js";
import { FunctionCall } from "./function.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";
import { ReturnStatement } from "./returnStatement.js";

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
