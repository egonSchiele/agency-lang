import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { InterruptEffect } from "../symbolTable.js";

export type ExportedFunction = {
  kind: "function";
  name: string;
  description: string;
  agencyFunction: AgencyFunction;
  interruptEffects: InterruptEffect[];
};

export type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  invoke: (...args: unknown[]) => Promise<unknown>;
  interruptEffects: InterruptEffect[];
};

export type ExportedItem = ExportedFunction | ExportedNode;
