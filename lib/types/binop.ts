import { BaseNode } from "./base.js";
import { Expression } from "../types.js";

export type BinOpArgument = Expression;

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
  | "||"
  | "!"
  | "|>"
  | "catch";

export const PRECEDENCE: Record<string, number> = {
  "|>": -1,
  "catch": 0,
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
  "!": 7,
};

export type BinOpExpression = BaseNode & {
  type: "binOpExpression";
  operator: Operator;
  left: Expression;
  right: Expression;
};
