import { AgencyNode, Expression, FunctionCall } from "../types.js";
import { BaseNode } from "./base.js";

export type AccessChainElement =
  | { kind: "property"; name: string }
  | { kind: "index"; index: Expression }
  | { kind: "methodCall"; functionCall: FunctionCall };

export type ValueAccess = BaseNode & {
  type: "valueAccess";
  base: AgencyNode;
  chain: AccessChainElement[];
  async?: boolean;
};
