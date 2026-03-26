import type { AgencyNode } from "../types.js";
import type { FunctionParameter } from "./function.js";

export type HandleBlock = {
  type: "handleBlock";
  body: AgencyNode[];
  handler:
    | { kind: "inline"; param: FunctionParameter; body: AgencyNode[] }
    | { kind: "functionRef"; functionName: string };
};
