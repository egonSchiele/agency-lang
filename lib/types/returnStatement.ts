import {
  AgencyNode,
  FunctionCall,
  Literal,
} from "../types.js";
import { ValueAccess } from "./access.js";
import { BinOpExpression } from "./binop.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";

export type ReturnStatement = {
  type: "returnStatement";
  value:
    | ValueAccess
    | FunctionCall
    | Literal
    | AgencyObject
    | AgencyArray
    | BinOpExpression;
};
