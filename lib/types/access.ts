import { AgencyNode, FunctionCall } from "../types.js";

export type AccessChainElement =
  | { kind: "property"; name: string }
  | { kind: "index"; index: AgencyNode }
  | { kind: "methodCall"; functionCall: FunctionCall };

export type ValueAccess = {
  type: "valueAccess";
  base: AgencyNode;
  chain: AccessChainElement[];
  async?: boolean;
};
