import { AccessExpression, AgencyNode, FunctionCall, Literal } from "@/types";
import { AgencyArray, AgencyObject } from "./dataStructures";

export type ReturnStatement = {
  type: "returnStatement";
  value: AccessExpression | FunctionCall | Literal | AgencyObject | AgencyArray;
};
