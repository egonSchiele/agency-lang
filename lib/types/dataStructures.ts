import { AccessExpression, Literal } from "@/types";
import { FunctionCall } from "./function";

export type AgencyArray = {
  type: "agencyArray";
  items: (
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
