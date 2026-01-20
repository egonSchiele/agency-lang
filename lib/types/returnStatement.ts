import {
  AccessExpression,
  AgencyNode,
  FunctionCall,
  IndexAccess,
  Literal,
} from "../types.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";

export type ReturnStatement = {
  type: "returnStatement";
  value:
    | AccessExpression
    | FunctionCall
    | Literal
    | AgencyObject
    | AgencyArray
    | IndexAccess;
};
