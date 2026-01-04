import { AccessExpression, ADLNode, FunctionCall, Literal } from "@/types";
import { ADLArray, ADLObject } from "./dataStructures";

export type ReturnStatement = {
  type: "returnStatement";
  value: AccessExpression | FunctionCall | Literal | ADLObject | ADLArray;
};
