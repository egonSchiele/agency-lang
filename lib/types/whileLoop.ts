import {
  AgencyNode,
  FunctionCall,
  Literal,
} from "../types.js";
import { ValueAccess } from "./access.js";
import { BinOpExpression } from "./binop.js";

export type WhileLoop = {
  type: "whileLoop";
  condition:
    | ValueAccess
    | FunctionCall
    | Literal
    | BinOpExpression;
  body: AgencyNode[];
};
