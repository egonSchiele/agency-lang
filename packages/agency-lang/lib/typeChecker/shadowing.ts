import type { AgencyNode } from "../types.js";

/**
 * Walk top-level program nodes once and collect the bookkeeping needed
 * for {@link isJsGlobalBase} (and similar shadowing checks). Cheap to
 * compute, but should be hoisted above the per-node walk so callers
 * don't pay it on every check.
 */
export function collectProgramShadowing(programNodes: readonly AgencyNode[]): {
  importedNodeNames: string[];
} {
  const importedNodeNames: string[] = [];
  for (const node of programNodes) {
    if (node.type === "importNodeStatement") {
      importedNodeNames.push(...node.importedNodes);
    }
  }
  return { importedNodeNames };
}
