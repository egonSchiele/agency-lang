import { z } from "zod";
import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { ExportedFunction, ExportedNode, ExportedItem } from "./types.js";
import type { ServedInvocationOutcome } from "../runtime/invocationUsage.js";

export type DiscoverOptions = {
  toolRegistry: Record<string, AgencyFunction>;
  moduleExports: Record<string, unknown>;
  moduleId: string;
  exportedNodeNames?: string[];
  interruptEffectsByName?: Record<string, InterruptEffect[]>;
};

/** The compiled module's generated serve-only invokers (see imports.mustache):
 *  they run a function / node inside a node-grade frame and return a
 *  `ServedInvocationOutcome` (value/error + per-invocation usage). */
type ServeFunctionInvoker = (
  fn: AgencyFunction,
  namedArgs: Record<string, unknown>,
) => Promise<ServedInvocationOutcome<unknown>>;
type ServeNodeInvoker = (
  nodeName: string,
  data: Record<string, any>,
) => Promise<ServedInvocationOutcome<unknown>>;

function isExportedFromModule(fn: AgencyFunction, moduleId: string): boolean {
  return !!fn.exported && !!fn.toolDefinition && fn.module === moduleId;
}

function toExportedFunction(
  fn: AgencyFunction,
  interruptEffects: InterruptEffect[],
  serveFn: ServeFunctionInvoker,
): ExportedFunction {
  return {
    kind: "function",
    name: fn.name,
    description: fn.toolDefinition!.description,
    // Only unbound params are caller-facing — bound params are filled at
    // definition time and rejected if sent. Matches `logRoutes` in adapter.ts.
    parameters: fn.params
      .filter((param) => !param.isBound)
      .map((param) => ({ name: param.name })),
    agencyFunction: fn,
    interruptEffects,
    invoke: (namedArgs) => serveFn(fn, namedArgs),
  };
}

/** A node's serve outcome carries a `RunNodeResult`; the caller-facing value is
 *  its `.data` (which is the interrupt array on a pause). Unwrap it while
 *  keeping the usage snapshot; a threw-outcome passes through untouched. */
function unwrapNodeOutcome(
  outcome: ServedInvocationOutcome<unknown>,
): ServedInvocationOutcome<unknown> {
  if (outcome.status === "returned") {
    const result = outcome.value as { data?: unknown } | undefined;
    return { ...outcome, value: result?.data };
  }
  return outcome;
}

function toExportedNode(
  nodeName: string,
  moduleExports: Record<string, unknown>,
  interruptEffects: InterruptEffect[],
  serveNode: ServeNodeInvoker,
): ExportedNode | null {
  // The node export still exists for CLI/debugger callers; use it only as an
  // existence check — serve invocation goes through __invokeNodeForServe.
  if (typeof moduleExports[nodeName] !== "function") return null;
  const raw = moduleExports[`__${nodeName}NodeParams`];
  const params = raw != null ? z.array(z.string()).parse(raw) : [];
  return {
    kind: "node",
    name: nodeName,
    parameters: params.map((name) => ({ name })),
    invoke: async (data) => unwrapNodeOutcome(await serveNode(nodeName, data)),
    interruptEffects,
  };
}

export function discoverExports(options: DiscoverOptions): ExportedItem[] {
  const { toolRegistry, moduleExports, moduleId, exportedNodeNames = [], interruptEffectsByName = {} } = options;

  const serveFn = moduleExports.__invokeFunctionForServe as ServeFunctionInvoker | undefined;
  const serveNode = moduleExports.__invokeNodeForServe as ServeNodeInvoker | undefined;
  // A bundle without the serve invokers predates the serve cost seam and cannot
  // report authoritative usage — fail fast rather than serve it uncounted.
  if (!serveFn || !serveNode || typeof moduleExports.__respondToInterruptsForServe !== "function") {
    throw new Error(
      "This agent bundle predates the serve cost seam and cannot be served. " +
        "Recompile with the current Agency (agency deploy / build) and try again.",
    );
  }

  const functions = Object.values(toolRegistry)
    .filter((fn) => isExportedFromModule(fn, moduleId))
    .map((fn) => toExportedFunction(fn, interruptEffectsByName[fn.name] ?? [], serveFn));

  const nodes = exportedNodeNames
    .map((name) => toExportedNode(name, moduleExports, interruptEffectsByName[name] ?? [], serveNode))
    .filter((n): n is ExportedNode => n !== null);

  return [...functions, ...nodes];
}
