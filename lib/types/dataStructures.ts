import { AccessExpression, Literal } from "@/types";
import { FunctionCall } from "./function";

export type ADLArray = {
  type: "adlArray";
  items: (
    | AccessExpression
    | Literal
    | FunctionCall
    | ADLObject
    | ADLArray
    | AccessExpression
  )[];
};

export type ADLObjectKV = {
  key: string;
  value:
    | AccessExpression
    | Literal
    | FunctionCall
    | ADLObject
    | ADLArray
    | AccessExpression;
};
export type ADLObject = {
  type: "adlObject";
  entries: ADLObjectKV[];
};
