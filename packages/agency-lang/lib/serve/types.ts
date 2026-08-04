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
   * PUBLIC contract, unchanged: invoke the function for a single request and
   * return its raw value, or throw the identical error. This is the member host
   * apps that construct/consume `ExportedFunction` directly depend on.
   */
  invoke: (namedArgs: Record<string, unknown>) => Promise<unknown>;
  /**
   * INTERNAL, for the serve adapters: the same execution as `invoke`, but the
   * value-or-error is returned inside a `ServedInvocationOutcome` alongside a
   * per-invocation usage snapshot (never mutating the value/error). Populated by
   * `discoverExports` from the compiled module's `__invokeFunctionForServe`.
   */
  invokeServed: (namedArgs: Record<string, unknown>) => Promise<ServedInvocationOutcome<unknown>>;
};

export type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  /** PUBLIC contract, unchanged: positional args → raw `RunNodeResult`, or throw. */
  invoke: (...args: unknown[]) => Promise<unknown>;
  /** INTERNAL, for the serve adapters: named args as a data object → a
   *  `ServedInvocationOutcome` whose `value` is the node's caller-facing data
   *  (`RunNodeResult.data`, already unwrapped by `discoverExports`) + usage. */
  invokeServed: (data: Record<string, unknown>) => Promise<ServedInvocationOutcome<unknown>>;
  interruptEffects: InterruptEffect[];
};

export type ExportedItem = ExportedFunction | ExportedNode;
