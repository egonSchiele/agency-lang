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

function isExportedFromModule(fn: AgencyFunction, moduleId: string): boolean {
  return !!fn.exported && !!fn.toolDefinition && fn.module === moduleId;
}

function toExportedFunction(fn: AgencyFunction, interruptEffects: InterruptEffect[]): ExportedFunction {
  return {
    kind: "function",
    name: fn.name,
    description: fn.toolDefinition!.description,
    agencyFunction: fn,
    interruptEffects,
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

  const functions = Object.values(toolRegistry)
    .filter((fn) => isExportedFromModule(fn, moduleId))
    .map((fn) => toExportedFunction(fn, interruptEffectsByName[fn.name] ?? []));

  const nodes = exportedNodeNames
    .map((name) => toExportedNode(name, moduleExports, interruptEffectsByName[name] ?? []))
    .filter((n): n is ExportedNode => n !== null);

  return [...functions, ...nodes];
}
