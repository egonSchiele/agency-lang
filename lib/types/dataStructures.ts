import { AccessExpression, IndexAccess, Literal } from "../types.js";
import { FunctionCall } from "./function.js";

export type AgencyArray = {
  type: "agencyArray";
  items: (
    | IndexAccess
    | AccessExpression
    | Literal
    | FunctionCall
    | AgencyObject
    | AgencyArray
    | AccessExpression
  )[];
};

export type AgencyObjectKV = {
  key: string;
  value:
    | IndexAccess
    | AccessExpression
    | Literal
    | FunctionCall
    | AgencyObject
    | AgencyArray
    | AccessExpression;
};
export type AgencyObject = {
  type: "agencyObject";
  entries: AgencyObjectKV[];
};
