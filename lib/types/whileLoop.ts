import {
  AccessExpression,
  AgencyNode,
  FunctionCall,
  IndexAccess,
  Literal,
} from "../types.js";
import { BinOpExpression } from "./binop.js";

export type WhileLoop = {
  type: "whileLoop";
  condition:
    | IndexAccess
    | FunctionCall
    | AccessExpression
    | Literal
    | BinOpExpression;
  body: AgencyNode[];
};
