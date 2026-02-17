import {
  AccessExpression,
  AgencyNode,
  FunctionCall,
  IndexAccess,
  Literal,
} from "../types.js";
import { AwaitStatement } from "./await.js";
import { BinOpExpression } from "./binop.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";

export type ReturnStatement = {
  type: "returnStatement";
  value:
    | AccessExpression
    | FunctionCall
    | Literal
    | AgencyObject
    | AgencyArray
    | IndexAccess
    | BinOpExpression;
};
