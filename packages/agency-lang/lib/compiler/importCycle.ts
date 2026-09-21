/**
 * Import cycles between `.agency` files (issue #541).
 *
 * A cycle compiles, then crashes when the program loads. Each module
 * registers the names it imports as tools at its top level, so with
 * `a.agency` and `b.agency` importing each other, `b.js` runs
 * `__registerTool(aVal)` while `a.js` is still half loaded, and Node reports
 * "Cannot access 'aVal' before initialization". A cycle of type-only imports
 * fails the same way, so every cycle is refused.
 */
import path from "path";

/** Module path to the module paths it imports. */
export type ImportGraph = Record<string, string[]>;

/**
 * One cycle in the graph, as the list of modules around it, or null. The list
 * starts at the first module of the cycle the search reaches and does not
 * repeat it at the end.
 */
export function findImportCycle(graph: ImportGraph): string[] | null {
  const finished: Record<string, true> = {};

  const search = (moduleId: string, trail: string[]): string[] | null => {
    const seenAt = trail.indexOf(moduleId);
    if (seenAt !== -1) {
      return trail.slice(seenAt);
    }
    if (finished[moduleId]) {
      return null;
    }
    for (const target of graph[moduleId] ?? []) {
      const cycle = search(target, [...trail, moduleId]);
      if (cycle) {
        return cycle;
      }
    }
    finished[moduleId] = true;
    return null;
  };

  for (const moduleId of Object.keys(graph)) {
    const cycle = search(moduleId, []);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

export function formatImportCycleError(cycle: string[]): string {
  const names = cycle.map((moduleId) => path.relative(process.cwd(), moduleId));
  const loop = [...names, names[0]].join(" → ");
  return [
    "Error: Circular import",
    `  ${loop}`,
    "Each module registers the names it imports when it loads, so a module in " +
      "a cycle would read a name before the other module has defined it, and " +
      "the program would crash at startup.",
    "Break the cycle by moving the shared definitions into a third file that " +
      "both import, or by moving the higher-level function out of the " +
      "lower-level module.",
  ].join("\n");
}
