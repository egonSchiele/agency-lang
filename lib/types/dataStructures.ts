import { Literal } from "../types.js";
import { ValueAccess } from "./access.js";
import { BaseNode } from "./base.js";
import { FunctionCall } from "./function.js";

export type SplatExpression = {
  type: "splat";
  value: ValueAccess | FunctionCall | Literal;
};

export type AgencyArray = BaseNode & {
  type: "agencyArray";
  items: (
    | ValueAccess
    | Literal
    | FunctionCall
    | AgencyObject
    | AgencyArray
    | SplatExpression
  )[];
};

export type AgencyObjectKV = {
  key: string;
  value:
    | ValueAccess
    | Literal
    | FunctionCall
    | AgencyObject
    | AgencyArray;
};
export type AgencyObject = BaseNode & {
  type: "agencyObject";
  entries: (AgencyObjectKV | SplatExpression)[];
};
