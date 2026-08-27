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
  // Unary minus (`-x`). Distinct from binary `-` so consumers can tell
  // `{ op: "unary-", left: true, right: x }` from `a - b`.
  | "unary-"
  | "typeof"
  | "void"
  | "++"
  | "--"
  | "instanceof"
  | "in"
  | "=~"
  | "!~"
  | "??"
  | "|>"
  | "catch";

export const PRECEDENCE: Record<string, number> = {
  "|>": -1,
  catch: 0,
  "??": 1,
  "||": 1,
  "&&": 2,
  "==": 3,
  "===": 3,
  "!=": 3,
  "!==": 3,
  "=~": 3,
  "!~": 3,
  instanceof: 4,
  in: 4,
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
  "++": 9,
  "--": 9,
  "!": 8,
  "unary-": 8,
  typeof: 8,
  void: 8,
};

/** The prefix operators the parser desugars to `{ op, left: true, right }`. */
export const PREFIX_OPS: Operator[] = ["!", "unary-", "typeof", "void"];

export type BinOpExpression = BaseNode & {
  type: "binOpExpression";
  operator: Operator;
  left: Expression;
  right: Expression;
};
