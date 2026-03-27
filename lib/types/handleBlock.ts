import type { AgencyNode } from "../types.js";
import type { BaseNode } from "./base.js";
import type { FunctionParameter } from "./function.js";

export type HandleBlock = BaseNode & {
  type: "handleBlock";
  body: AgencyNode[];
  handler:
    | { kind: "inline"; param: FunctionParameter; body: AgencyNode[] }
    | { kind: "functionRef"; functionName: string };
};
