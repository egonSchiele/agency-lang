import { Expression } from "../types.js";
import { BaseNode } from "./base.js";

export const specialVarNames = ["model", "messages"] as const;
export type SpecialVarName = (typeof specialVarNames)[number];

export type SpecialVar = BaseNode & {
  type: "specialVar";
  name: SpecialVarName;
  value: Expression;
};
