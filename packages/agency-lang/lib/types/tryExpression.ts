import { BaseNode } from "./base.js";
import type { FunctionCall } from "./function.js";
import type { ValueAccess } from "./access.js";

export type TryExpression = BaseNode & {
  type: "tryExpression";
  call: FunctionCall | ValueAccess;
};
