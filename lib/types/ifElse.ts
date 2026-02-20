import {
  AgencyNode,
  FunctionCall,
  Literal,
} from "../types.js";
import { ValueAccess } from "./access.js";
import { BinOpExpression } from "./binop.js";

export type IfElse = {
  type: "ifElse";
  condition:
    | ValueAccess
    | FunctionCall
    | Literal
    | BinOpExpression;
  thenBody: AgencyNode[];
  elseBody?: AgencyNode[]; // Optional for if-only statements
};
