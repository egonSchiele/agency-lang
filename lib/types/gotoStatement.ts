import { BaseNode } from "./base.js";
import { FunctionCall } from "./function.js";

export type GotoStatement = BaseNode & {
  type: "gotoStatement";
  nodeCall: FunctionCall;
};
