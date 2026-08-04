import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { ServedInvocationOutcome } from "../runtime/invocationUsage.js";

export type ExportedFunction = {
  kind: "function";
  name: string;
  description: string;
  /** Names of the function's parameters, in declaration order — mirrors
   *  `ExportedNode.parameters` so the manifest describes both the same way. */
  parameters: Array<{ name: string }>;
  agencyFunction: AgencyFunction;
  interruptEffects: InterruptEffect[];
  /**
   * Invoke the function for a single request, given its named arguments, and
   * return a `ServedInvocationOutcome`: the raw function value (on `returned`)
   * or the identical thrown error (on `threw`), plus a per-invocation usage
   * snapshot. Populated by `discoverExports` from the compiled module's
   * generated `__invokeFunctionForServe`, which runs the body inside a
   * node-grade execution frame. An adapter unit test may supply a plain-JS
   * invoke that returns an outcome directly.
   */
  invoke: (namedArgs: Record<string, unknown>) => Promise<ServedInvocationOutcome<unknown>>;
};

export type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  /** Invoke the node with its named args as a data object, returning a
   *  `ServedInvocationOutcome` whose `value` is the node's caller-facing data
   *  (the `RunNodeResult.data`, already unwrapped by `discoverExports`). */
  invoke: (data: Record<string, unknown>) => Promise<ServedInvocationOutcome<unknown>>;
  interruptEffects: InterruptEffect[];
};

export type ExportedItem = ExportedFunction | ExportedNode;
