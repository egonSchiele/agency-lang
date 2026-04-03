import type { BaseNode } from "./base.js";

export type DebuggerStatement = BaseNode & {
  type: "debuggerStatement";
  label?: string;
  isUserAdded?: boolean;
};
