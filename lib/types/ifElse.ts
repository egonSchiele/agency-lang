import {
  AccessExpression,
  AgencyNode,
  FunctionCall,
  IndexAccess,
  Literal,
} from "../types.js";
import { BinOpExpression } from "./binop.js";

export type IfElse = {
  type: "ifElse";
  condition:
    | IndexAccess
    | FunctionCall
    | AccessExpression
    | Literal
    | BinOpExpression;
  thenBody: AgencyNode[];
  elseBody?: AgencyNode[]; // Optional for if-only statements
};
