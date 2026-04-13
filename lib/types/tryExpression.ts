import { BaseNode } from "./base.js";
import type { FunctionCall } from "./function.js";

export type TryExpression = BaseNode & {
  type: "tryExpression";
  call: FunctionCall;
};
