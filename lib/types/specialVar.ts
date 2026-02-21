import { ValueAccess } from "./access.js";
import { AgencyArray, AgencyObject } from "./dataStructures.js";
import { FunctionCall } from "./function.js";
import { Literal } from "./literals.js";

export const specialVarNames = ["model", "messages"] as const;
export type SpecialVarName = (typeof specialVarNames)[number];

export type SpecialVar = {
  type: "specialVar";
  name: SpecialVarName;
  value: Literal | AgencyObject | AgencyArray | ValueAccess | FunctionCall;
};
