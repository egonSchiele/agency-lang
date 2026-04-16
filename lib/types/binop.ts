import { BaseNode } from "./base.js";
import { Expression } from "../types.js";

export type BinOpArgument = Expression;

export type Operator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "=="
  | "==="
  | "!="
  | "!=="
  | "+="
  | "-="
  | "*="
  | "/="
  | "??="
  | "||="
  | "&&="
  | "<"
  | ">"
  | "<="
  | ">="
  | "&&"
  | "||"
  | "!"
  | "typeof"
  | "void"
  | "instanceof"
  | "in"
  | "=~"
  | "!~"
  | "??"
  | "|>"
  | "catch";

export const PRECEDENCE: Record<string, number> = {
  "|>": -1,
  "catch": 0,
  "??": 1,
  "||": 1,
  "&&": 2,
  "==": 3,
  "===": 3,
  "!=": 3,
  "!==": 3,
  "=~": 3,
  "!~": 3,
  "instanceof": 4,
  "in": 4,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "**": 7,
  "+=": 0,
  "-=": 0,
  "*=": 0,
  "/=": 0,
  "??=": 0,
  "||=": 0,
  "&&=": 0,
  "!": 8,
  "typeof": 8,
  "void": 8,
};

export type BinOpExpression = BaseNode & {
  type: "binOpExpression";
  operator: Operator;
  left: Expression;
  right: Expression;
};
