import { AgencyNode, Expression, FunctionCall } from "../types.js";
import { BaseNode } from "./base.js";

export type AccessChainElement =
  | { kind: "property"; name: string; optional?: boolean }
  | { kind: "index"; index: Expression; optional?: boolean }
  | { kind: "methodCall"; functionCall: FunctionCall; optional?: boolean };

export type ValueAccess = BaseNode & {
  type: "valueAccess";
  base: AgencyNode;
  chain: AccessChainElement[];
  async?: boolean;
};
