import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { InterruptEffect } from "../symbolTable.js";

export type ExportedFunction = {
  kind: "function";
  name: string;
  description: string;
  agencyFunction: AgencyFunction;
  interruptEffects: InterruptEffect[];
  /**
   * Invoke the function for a single request, given its named arguments.
   * Populated by `discoverExports` from the compiled module's generated
   * `__invokeFunction`, which runs the body inside a node-grade execution
   * frame — generated function bodies require an ambient Agency frame and
   * throw without one. Falls back to a bare `agencyFunction.invoke` for
   * modules compiled before `__invokeFunction` existed (and for tests that
   * build `ExportedFunction` from plain JS bodies that need no frame).
   */
  invoke: (namedArgs: Record<string, unknown>) => Promise<unknown>;
};

export type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  invoke: (...args: unknown[]) => Promise<unknown>;
  interruptEffects: InterruptEffect[];
};

export type ExportedItem = ExportedFunction | ExportedNode;
