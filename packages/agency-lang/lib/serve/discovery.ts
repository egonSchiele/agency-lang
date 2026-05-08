import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { ExportedFunction, ExportedNode, ExportedItem } from "./types.js";

export type DiscoverOptions = {
  toolRegistry: Record<string, AgencyFunction>;
  moduleExports: Record<string, unknown>;
  exportedNodeNames?: string[];
};

export function discoverExports(options: DiscoverOptions): ExportedItem[] {
  const { toolRegistry, moduleExports, exportedNodeNames = [] } = options;
  const items: ExportedItem[] = [];

  for (const fn of Object.values(toolRegistry)) {
    if (fn.exported && fn.toolDefinition) {
      items.push({
        kind: "function",
        name: fn.name,
        description: fn.toolDefinition.description,
        agencyFunction: fn,
      });
    }
  }

  for (const nodeName of exportedNodeNames) {
    const nodeFn = moduleExports[nodeName];
    if (typeof nodeFn !== "function") continue;
    const paramsKey = `__${nodeName}NodeParams`;
    const params = (moduleExports[paramsKey] as string[] | undefined) ?? [];
    items.push({
      kind: "node",
      name: nodeName,
      parameters: params.map((name) => ({ name })),
      invoke: nodeFn as (args: Record<string, unknown>) => Promise<unknown>,
    });
  }

  return items;
}
