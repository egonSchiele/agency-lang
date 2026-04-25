import type { BaseNode } from "./base.js";
import type { AgencyNode } from "../types.js";

export type WithModifier = BaseNode & {
  type: "withModifier";
  statement: AgencyNode;
  handlerName: "approve" | "reject" | "propagate";
};
