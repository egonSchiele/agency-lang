import { Assignment, AgencyComment, Expression } from "../types.js";
import { BaseNode } from "./base.js";
import { Literal } from "./literals.js";
import { FunctionCall } from "./function.js";
import { ValueAccess } from "./access.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";
import { ReturnStatement } from "./returnStatement.js";

export type DefaultCase = "_";

export type MatchBlockCase = {
  type: "matchBlockCase";
  caseValue: Expression | DefaultCase;
  body:
    | Assignment
    | Literal
    | FunctionCall
    | ValueAccess
    | AgencyArray
    | AgencyObject
    | ReturnStatement;
};

export type MatchBlock = BaseNode & {
  type: "matchBlock";
  expression: Expression;
  cases: (MatchBlockCase | AgencyComment)[];
};
