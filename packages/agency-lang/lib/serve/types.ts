import type { AgencyFunction } from "../runtime/agencyFunction.js";

export type ExportedFunction = {
  kind: "function";
  name: string;
  description: string;
  agencyFunction: AgencyFunction;
};

export type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  invoke: (...args: unknown[]) => Promise<unknown>;
};

export type ExportedItem = ExportedFunction | ExportedNode;
