import { Literal } from "../types.js";
import { ValueAccess } from "./access.js";
import { FunctionCall } from "./function.js";

export type AgencyArray = {
  type: "agencyArray";
  items: (
    | ValueAccess
    | Literal
    | FunctionCall
    | AgencyObject
    | AgencyArray
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
export type AgencyObject = {
  type: "agencyObject";
  entries: AgencyObjectKV[];
};
