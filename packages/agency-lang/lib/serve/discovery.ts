import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { ExportedFunction, ExportedNode, ExportedItem } from "./types.js";

export type DiscoverOptions = {
  toolRegistry: Record<string, AgencyFunction>;
  moduleExports: Record<string, unknown>;
  moduleId: string;
  exportedNodeNames?: string[];
};

function isExportedFromModule(fn: AgencyFunction, moduleId: string): boolean {
  return !!fn.exported && !!fn.toolDefinition && fn.module === moduleId;
}

function toExportedFunction(fn: AgencyFunction): ExportedFunction {
  return {
    kind: "function",
    name: fn.name,
    description: fn.toolDefinition!.description,
    agencyFunction: fn,
  };
}

function toExportedNode(
  nodeName: string,
  moduleExports: Record<string, unknown>,
): ExportedNode | null {
  const nodeFn = moduleExports[nodeName];
  if (typeof nodeFn !== "function") return null;
  const params = (moduleExports[`__${nodeName}NodeParams`] as string[] | undefined) ?? [];
  return {
    kind: "node",
    name: nodeName,
    parameters: params.map((name) => ({ name })),
    invoke: nodeFn as (args: Record<string, unknown>) => Promise<unknown>,
  };
}

export function discoverExports(options: DiscoverOptions): ExportedItem[] {
  const { toolRegistry, moduleExports, moduleId, exportedNodeNames = [] } = options;

  const functions = Object.values(toolRegistry)
    .filter((fn) => isExportedFromModule(fn, moduleId))
    .map(toExportedFunction);

  const nodes = exportedNodeNames
    .map((name) => toExportedNode(name, moduleExports))
    .filter((n): n is ExportedNode => n !== null);

  return [...functions, ...nodes];
}
