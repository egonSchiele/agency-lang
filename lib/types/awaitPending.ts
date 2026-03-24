import { AccessChainElement } from "./access.js";
import { ScopeType } from "@/types.js";

export type AwaitPendingVariable = {
  name: string;
  accessChain?: AccessChainElement[];
  scope?: ScopeType;
};

export type AwaitPending = {
  type: "awaitPending";
  variables: AwaitPendingVariable[];
};
