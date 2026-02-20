import { Assignment, AgencyComment } from "../types.js";
import { ValueAccess } from "./access.js";
import { Literal } from "./literals.js";
import { FunctionCall } from "./function.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";
import { ReturnStatement } from "./returnStatement.js";
import { BinOpExpression } from "./binop.js";

export type DefaultCase = "_";

export type MatchBlockCase = {
  type: "matchBlockCase";
  caseValue: ValueAccess | FunctionCall | Literal | DefaultCase;
  body:
    | Assignment
    | Literal
    | FunctionCall
    | ValueAccess
    | AgencyArray
    | AgencyObject
    | ReturnStatement;
};

export type MatchBlock = {
  type: "matchBlock";
  expression: Literal | BinOpExpression;
  cases: (MatchBlockCase | AgencyComment)[];
};
