import { ValueAccess } from "./access.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";
import { FunctionCall } from "./function.js";
import { Literal } from "./literals.js";

export type BinOpArgument =
  | ValueAccess
  | Literal
  | FunctionCall
  | AgencyObject
  | AgencyArray;

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
  | ">=";

export type BinOpExpression = {
  type: "binOpExpression";
  operator: Operator;
  left: BinOpArgument;
  right: BinOpArgument;
};
