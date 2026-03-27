import {
  AgencyNode,
  FunctionCall,
  Literal,
} from "../types.js";
import { ValueAccess } from "./access.js";
import { BaseNode } from "./base.js";
import { BinOpExpression } from "./binop.js";

export type WhileLoop = BaseNode & {
  type: "whileLoop";
  condition:
    | ValueAccess
    | FunctionCall
    | Literal
    | BinOpExpression;
  body: AgencyNode[];
};
