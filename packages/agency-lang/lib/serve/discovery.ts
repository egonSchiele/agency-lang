import { z } from "zod";
import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { ServedExportedFunction, ServedExportedNode, ServedExportedItem } from "./types.js";
import type { ServedInvocationOutcome } from "../runtime/invocationUsage.js";
import type { InvocationOptions } from "../runtime/invocationOptions.js";

export type DiscoverOptions = {
  toolRegistry: Record<string, AgencyFunction>;
  moduleExports: Record<string, unknown>;
  moduleId: string;
  exportedNodeNames?: string[];
  interruptEffectsByName?: Record<string, InterruptEffect[]>;
};

/** The compiled module's generated `__invokeFunction`: runs an exported function
 *  inside a node-grade frame and returns its RAW value (the public contract). */
type ModuleInvokeFunction = (
  fn: AgencyFunction,
  namedArgs: Record<string, unknown>,
) => Promise<unknown>;

/** The generated serve-only invokers: same execution, returning a
 *  `ServedInvocationOutcome` (value/error + usage) for the adapters. */
type ServeFunctionInvoker = (
  fn: AgencyFunction,
  namedArgs: Record<string, unknown>,
  invocation?: InvocationOptions,
) => Promise<ServedInvocationOutcome<unknown>>;
type ServeNodeInvoker = (
  nodeName: string,
  data: Record<string, any>,
  invocation?: InvocationOptions,
) => Promise<ServedInvocationOutcome<unknown>>;

function isExportedFromModule(fn: AgencyFunction, moduleId: string): boolean {
  return !!fn.exported && !!fn.toolDefinition && fn.module === moduleId;
}

/** The public raw invoker: prefer the module's `__invokeFunction`, falling back
 *  to a bare `agencyFunction.invoke` for older bundles / plain-JS test bodies. */
function makeRawInvoker(
  fn: AgencyFunction,
  moduleInvoke: ModuleInvokeFunction | undefined,
): (namedArgs: Record<string, unknown>) => Promise<unknown> {
  if (moduleInvoke) return (namedArgs) => moduleInvoke(fn, namedArgs);
  return (namedArgs) => fn.invoke({ type: "named", positionalArgs: [], namedArgs });
}

function toExportedFunction(
  fn: AgencyFunction,
  interruptEffects: InterruptEffect[],
  moduleInvoke: ModuleInvokeFunction | undefined,
  serveFn: ServeFunctionInvoker,
): ServedExportedFunction {
  return {
    kind: "function",
    name: fn.name,
    description: fn.toolDefinition!.description,
    // Only unbound params are caller-facing — bound params are filled at
    // definition time and rejected if sent. Matches `logRoutes` in adapter.ts.
    parameters: fn.params.filter((param) => !param.isBound).map((param) => ({ name: param.name })),
    agencyFunction: fn,
    interruptEffects,
    invoke: makeRawInvoker(fn, moduleInvoke),
    invokeServed: (namedArgs, invocation) => serveFn(fn, namedArgs, invocation),
  };
}

/** A node's serve outcome carries a `RunNodeResult`; the caller-facing value is
 *  its `.data` (the interrupt array on a pause). Unwrap it while keeping the
 *  usage snapshot; a threw-outcome passes through untouched. */
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
): ServedExportedNode | null {
  const rawNodeFn = moduleExports[nodeName];
  if (typeof rawNodeFn !== "function") return null;
  const raw = moduleExports[`__${nodeName}NodeParams`];
  const params = raw != null ? z.array(z.string()).parse(raw) : [];
  return {
    kind: "node",
    name: nodeName,
    parameters: params.map((name) => ({ name })),
    // Public: the raw node export (positional args → RunNodeResult).
    invoke: rawNodeFn as (...args: unknown[]) => Promise<unknown>,
    // Internal: serve invoker (data object → outcome, node .data unwrapped).
    invokeServed: async (data, invocation) =>
      unwrapNodeOutcome(await serveNode(nodeName, data, invocation)),
    interruptEffects,
  };
}

const RECOMPILE_HINT =
  "Recompile with the current Agency (agency deploy / build) and try again — " +
  "served bundles must be recompiled to report per-invocation usage.";

export function discoverExports(options: DiscoverOptions): ServedExportedItem[] {
  const {
    toolRegistry,
    moduleExports,
    moduleId,
    exportedNodeNames = [],
    interruptEffectsByName = {},
  } = options;

  const moduleInvoke = moduleExports.__invokeFunction as ModuleInvokeFunction | undefined;
  const serveFn = moduleExports.__invokeFunctionForServe as ServeFunctionInvoker | undefined;
  const serveNode = moduleExports.__invokeNodeForServe as ServeNodeInvoker | undefined;

  const exportedFns = Object.values(toolRegistry).filter((fn) =>
    isExportedFromModule(fn, moduleId),
  );

  // Require each serve invoker ONLY for the kind actually present, so a
  // node-only bundle need not carry the function invoker (and vice versa). A
  // bundle that predates the seam for a kind it exports fails fast rather than
  // serving that kind uncounted.
  if (exportedFns.length > 0 && !serveFn) {
    throw new Error(
      `This agent bundle predates the serve cost seam (no __invokeFunctionForServe). ${RECOMPILE_HINT}`,
    );
  }
  const presentNodes = exportedNodeNames.filter(
    (name) => typeof moduleExports[name] === "function",
  );
  if (presentNodes.length > 0 && !serveNode) {
    throw new Error(
      `This agent bundle predates the serve cost seam (no __invokeNodeForServe). ${RECOMPILE_HINT}`,
    );
  }

  const functions = exportedFns.map((fn) =>
    toExportedFunction(fn, interruptEffectsByName[fn.name] ?? [], moduleInvoke, serveFn!),
  );
  const nodes = exportedNodeNames
    .map((name) =>
      toExportedNode(name, moduleExports, interruptEffectsByName[name] ?? [], serveNode!),
    )
    .filter((n): n is ServedExportedNode => n !== null);

  return [...functions, ...nodes];
}
