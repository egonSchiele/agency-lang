import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { InterruptKind } from "../symbolTable.js";

export type ExportedFunction = {
  kind: "function";
  name: string;
  description: string;
  agencyFunction: AgencyFunction;
  interruptKinds: InterruptKind[];
};

export type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  invoke: (...args: unknown[]) => Promise<unknown>;
  interruptKinds: InterruptKind[];
};

export type ExportedItem = ExportedFunction | ExportedNode;
