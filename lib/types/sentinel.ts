import type { BaseNode } from "./base.js";
import type { AgencyNode, ScopeType } from "../types.js";

export type Sentinel = BaseNode & {
  type: "sentinel";
  value: "checkpoint";
  data: {
    targetVariable: string;
    prompt: AgencyNode;
    scope: ScopeType;
  };
};
