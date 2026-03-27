import { AccessChainElement } from "./access.js";
import { BaseNode } from "./base.js";
import { ScopeType } from "@/types.js";

export type AwaitPendingVariable = {
  name: string;
  accessChain?: AccessChainElement[];
  scope?: ScopeType;
};

export type AwaitPending = BaseNode & {
  type: "awaitPending";
  variables: AwaitPendingVariable[];
};
