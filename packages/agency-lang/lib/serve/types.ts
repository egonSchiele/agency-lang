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
   * Invoke the function for a single request and return its raw value, or throw
   * the identical error. Unchanged public contract — the member host apps that
   * construct/consume `ExportedFunction` directly depend on.
   */
  invoke: (namedArgs: Record<string, unknown>) => Promise<unknown>;
};

export type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  /** Positional args → raw `RunNodeResult`, or throw. Unchanged public contract. */
  invoke: (...args: unknown[]) => Promise<unknown>;
  interruptEffects: InterruptEffect[];
};

export type ExportedItem = ExportedFunction | ExportedNode;

// --- Internal, NOT part of the public `agency-lang/serve` surface. ---
//
// The serve adapters additionally need a usage-bearing invoker. Rather than add
// a required member to the PUBLIC `ExportedFunction`/`ExportedNode` (which would
// break host apps that construct them), the adapters use these internal
// `Served*` supertypes: the same shape plus `invokeServed`, which
// `discoverExports` populates from the compiled module's `…ForServe` invokers.
// `invokeServed` returns the value-or-error inside a `ServedInvocationOutcome`
// (never mutating either) with a per-invocation usage snapshot; a node's value
// is its caller-facing `RunNodeResult.data`, already unwrapped by discovery.

export type ServedExportedFunction = ExportedFunction & {
  invokeServed: (namedArgs: Record<string, unknown>) => Promise<ServedInvocationOutcome<unknown>>;
};

export type ServedExportedNode = ExportedNode & {
  invokeServed: (data: Record<string, unknown>) => Promise<ServedInvocationOutcome<unknown>>;
};

export type ServedExportedItem = ServedExportedFunction | ServedExportedNode;
