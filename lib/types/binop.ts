import { ValueAccess } from "./access.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";
import { FunctionCall } from "./function.js";
import { Literal } from "./literals.js";

export type BinOpArgument =
  | ValueAccess
  | Literal
  | FunctionCall
  | AgencyObject
  | AgencyArray
  | BinOpExpression;

export type Operator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "=="
  | "!="
  | "+="
  | "-="
  | "*="
  | "/="
  | "<"
  | ">"
  | "<="
  | ">="
  | "&&"
  | "||";

export const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "+=": 0,
  "-=": 0,
  "*=": 0,
  "/=": 0,
};

export type BinOpExpression = {
  type: "binOpExpression";
  operator: Operator;
  left: BinOpArgument;
  right: BinOpArgument;
};
