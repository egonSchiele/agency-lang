import { z } from "zod";
import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { ExportedFunction, ExportedNode, ExportedItem } from "./types.js";

export type DiscoverOptions = {
  toolRegistry: Record<string, AgencyFunction>;
  moduleExports: Record<string, unknown>;
  moduleId: string;
  exportedNodeNames?: string[];
  interruptEffectsByName?: Record<string, InterruptEffect[]>;
};

/**
 * The compiled module's generated `__invokeFunction`: runs an exported
 * function inside a node-grade execution frame. Optional because modules
 * compiled before it existed won't export it.
 */
type ModuleInvokeFunction = (
  fn: AgencyFunction,
  namedArgs: Record<string, unknown>,
) => Promise<unknown>;

function isExportedFromModule(fn: AgencyFunction, moduleId: string): boolean {
  return !!fn.exported && !!fn.toolDefinition && fn.module === moduleId;
}

/**
 * Build the per-request invoker for a function. Prefers the compiled
 * module's `__invokeFunction`, which runs the body inside a node-grade
 * execution frame (generated function bodies throw without an ambient
 * Agency frame). Falls back to a bare `agencyFunction.invoke` when the
 * module predates `__invokeFunction`.
 *
 * The fallback preserves the prior (broken) behavior for such stale
 * bundles rather than masking it: a pre-`__invokeFunction` module will
 * keep throwing "getRuntimeContext() called outside an Agency execution
 * frame" on function calls until it is recompiled. Recompiling is the
 * fix; the fallback only avoids a hard crash here (and keeps the path
 * working for the plain-JS function bodies used in adapter unit tests).
 */
function makeInvoker(
  fn: AgencyFunction,
  moduleInvoke: ModuleInvokeFunction | undefined,
): (namedArgs: Record<string, unknown>) => Promise<unknown> {
  if (moduleInvoke) {
    return (namedArgs) => moduleInvoke(fn, namedArgs);
  }
  return (namedArgs) => fn.invoke({ type: "named", positionalArgs: [], namedArgs });
}

function toExportedFunction(
  fn: AgencyFunction,
  interruptEffects: InterruptEffect[],
  moduleInvoke: ModuleInvokeFunction | undefined,
): ExportedFunction {
  return {
    kind: "function",
    name: fn.name,
    description: fn.toolDefinition!.description,
    agencyFunction: fn,
    interruptEffects,
    invoke: makeInvoker(fn, moduleInvoke),
  };
}

function toExportedNode(
  nodeName: string,
  moduleExports: Record<string, unknown>,
  interruptEffects: InterruptEffect[],
): ExportedNode | null {
  const nodeFn = moduleExports[nodeName];
  if (typeof nodeFn !== "function") return null;
  const raw = moduleExports[`__${nodeName}NodeParams`];
  const params = raw != null ? z.array(z.string()).parse(raw) : [];
  return {
    kind: "node",
    name: nodeName,
    parameters: params.map((name) => ({ name })),
    invoke: nodeFn as (...args: unknown[]) => Promise<unknown>,
    interruptEffects,
  };
}

export function discoverExports(options: DiscoverOptions): ExportedItem[] {
  const { toolRegistry, moduleExports, moduleId, exportedNodeNames = [], interruptEffectsByName = {} } = options;

  const moduleInvoke = moduleExports.__invokeFunction as ModuleInvokeFunction | undefined;

  const functions = Object.values(toolRegistry)
    .filter((fn) => isExportedFromModule(fn, moduleId))
    .map((fn) => toExportedFunction(fn, interruptEffectsByName[fn.name] ?? [], moduleInvoke));

  const nodes = exportedNodeNames
    .map((name) => toExportedNode(name, moduleExports, interruptEffectsByName[name] ?? []))
    .filter((n): n is ExportedNode => n !== null);

  return [...functions, ...nodes];
}
