/**
 * Topological sort over the per-variable init dep graph (built by
 * `initDepGraph.ts`).
 *
 * Two outputs:
 *  - {@link topSortInitGraph} on success returns an array of
 *    `InitVarKey` in initialization order (deps first).
 *  - on cycle it returns a structured `CycleError` listing the cycle
 *    path so Task 3 can render a clean compile-time error.
 *
 * Ordering rule:
 *  - Var-level edges always win. If `a` depends on `b`, `b` must
 *    appear before `a`.
 *  - Otherwise, fall back to the file-import DAG: for two
 *    var-edge-unordered nodes, the one whose module is imported
 *    (directly or transitively) BEFORE the other's module comes
 *    first. This handles example 2 from the design doc, where
 *    `fooStatic = getBarStatic() + "!"` has no direct value edge on
 *    bar but bar must init first because foo imports bar.
 *  - Final tiebreak is lexicographic on the node key (moduleId::name)
 *    so the output is deterministic regardless of object-iteration
 *    order across JS engines.
 *
 * Implementation: Kahn's algorithm with a priority queue (sorted by
 * the tiebreak rules above) over zero-in-degree nodes.
 */

import type { InitDepGraph, InitVarKey, InitVarNode } from "./initDepGraph.js";

export type CycleError = {
  kind: "cycle";
  /** A representative cycle path: a list of nodes where each depends on
   * the next, and the last depends on the first. */
  cycle: InitVarNode[];
};

export type TopSortResult =
  | { kind: "ok"; order: InitVarKey[] }
  | CycleError;

export function topSortInitGraph(graph: InitDepGraph): TopSortResult {
  // 1. Compute in-degree per node (number of incoming "depends-on"
  //    edges, i.e. how many other nodes list this one as a dep).
  // Important: `graph.edges` maps node → its deps; for Kahn's algorithm
  // we need the reverse — from dep → dependents — and per-node in-degree.
  const reverse: Record<InitVarKey, InitVarKey[]> = {};
  const inDegree: Record<InitVarKey, number> = {};
  for (const key of Object.keys(graph.nodes)) {
    inDegree[key] = 0;
    reverse[key] = [];
  }
  for (const [key, deps] of Object.entries(graph.edges)) {
    for (const dep of deps) {
      // Edge: key depends on dep, so dep -> key.
      // (Defensive guard against stale references — skip deps not in nodes.)
      if (inDegree[dep] === undefined) continue;
      reverse[dep].push(key);
      inDegree[key] = (inDegree[key] ?? 0) + 1;
    }
  }

  // 2. Compute file-import ordering: for each module, what is its
  //    "depth" in a topological walk of the file-import DAG? Modules
  //    that are leaves in the DAG (no agency imports) come first
  //    (low depth → init first). On a file-import cycle (allowed by
  //    the design) the depth of nodes inside the SCC is just their
  //    BFS distance from a leaf — not perfectly principled, but stable
  //    and adequate for the tiebreak.
  const fileOrder = computeFileImportOrder(graph);

  // Compare two keys for ordering of the "ready" set (Kahn's algorithm
  // bag of zero-in-degree nodes). Lower wins (popped first).
  const cmp = (a: InitVarKey, b: InitVarKey): number => {
    const na = graph.nodes[a]!;
    const nb = graph.nodes[b]!;
    const fa = fileOrder[na.moduleId] ?? Number.POSITIVE_INFINITY;
    const fb = fileOrder[nb.moduleId] ?? Number.POSITIVE_INFINITY;
    if (fa !== fb) return fa - fb;
    // Within the same module, declaration order wins. Approximate it
    // by source-line if locations are available.
    const la = na.loc?.line ?? 0;
    const lb = nb.loc?.line ?? 0;
    if (la !== lb) return la - lb;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  // 3. Kahn's loop: repeatedly take the smallest-by-cmp zero-in-degree
  //    node and emit it, decrementing in-degrees of its dependents.
  const ready: InitVarKey[] = Object.keys(inDegree).filter(
    (k) => inDegree[k] === 0,
  );
  ready.sort(cmp);
  const order: InitVarKey[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    order.push(key);
    for (const dep of reverse[key] ?? []) {
      inDegree[dep] = (inDegree[dep] ?? 0) - 1;
      if (inDegree[dep] === 0) {
        // Insert maintaining sort order.
        insertSorted(ready, dep, cmp);
      }
    }
  }

  if (order.length === Object.keys(graph.nodes).length) {
    return { kind: "ok", order };
  }

  // 4. Cycle: find a representative cycle by walking from any
  //    still-positive in-degree node along edges, tracking the path.
  return findCycle(graph, inDegree);
}

function insertSorted(
  arr: InitVarKey[],
  key: InitVarKey,
  cmp: (a: InitVarKey, b: InitVarKey) => number,
): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(arr[mid], key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, key);
}

/**
 * Assign each module a numeric "import order" — lower numbers come
 * earlier, mirroring a topological walk of the file-import DAG.
 *
 * Implementation: a Kahn pass over the reversed file-import graph
 * (so leaves — modules that import nothing — get the smallest
 * numbers). File-level cycles (allowed by design — the router pattern)
 * are tolerated: any module left after the Kahn pass is assigned a
 * depth equal to the longest path it could otherwise reach.
 */
function computeFileImportOrder(graph: InitDepGraph): Record<string, number> {
  const all = new Set<string>();
  for (const n of Object.values(graph.nodes)) all.add(n.moduleId);
  for (const m of Object.keys(graph.fileImports)) all.add(m);
  const modules = [...all];

  // Build dep counts: for each module, how many of its imports are
  // also tracked modules. (Skip imports outside `modules` — they're
  // unreachable from the entry and shouldn't affect ordering.)
  const inDeg: Record<string, number> = {};
  const dependents: Record<string, string[]> = {};
  for (const m of modules) {
    inDeg[m] = 0;
    dependents[m] = [];
  }
  for (const m of modules) {
    const imports = graph.fileImports[m] ?? [];
    for (const imp of imports) {
      if (!(imp in inDeg)) continue;
      dependents[imp].push(m);
      inDeg[m]++;
    }
  }

  const order: Record<string, number> = {};
  let counter = 0;
  const ready = modules.filter((m) => inDeg[m] === 0).sort();
  while (ready.length > 0) {
    const m = ready.shift()!;
    order[m] = counter++;
    for (const dep of dependents[m]) {
      inDeg[dep]--;
      if (inDeg[dep] === 0) insertSortedString(ready, dep);
    }
  }
  // Anything left is inside a file-import cycle — assign them the
  // tail of the ordering in lexicographic order so the tiebreak stays
  // stable.
  const leftover = modules.filter((m) => order[m] === undefined).sort();
  for (const m of leftover) order[m] = counter++;
  return order;
}

function insertSortedString(arr: string[], key: string): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= key) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, key);
}

/**
 * Find any cycle in the dep graph (called only when topsort has
 * confirmed one exists). Returns a CycleError naming the participating
 * decls in order — first node depends on second, second on third, …,
 * last on first.
 */
function findCycle(
  graph: InitDepGraph,
  inDegree: Record<InitVarKey, number>,
): CycleError {
  // Start from any node with nonzero remaining in-degree; walk one
  // outgoing edge at a time until we revisit a node — that closes the
  // cycle.
  const start = Object.keys(inDegree).find((k) => inDegree[k] > 0);
  if (!start) {
    // Should not happen — caller only invokes this when there IS a cycle.
    return { kind: "cycle", cycle: [] };
  }
  const path: InitVarKey[] = [];
  const onPath: Record<InitVarKey, number> = {};
  let cur = start;
  for (let i = 0; i < Object.keys(graph.nodes).length + 1; i++) {
    if (onPath[cur] !== undefined) {
      // Cycle detected. Trim path back to the loop start.
      const loop = path.slice(onPath[cur]);
      return { kind: "cycle", cycle: loop.map((k) => graph.nodes[k]!) };
    }
    onPath[cur] = path.length;
    path.push(cur);
    // Follow the first dep that still has positive in-degree (a cycle
    // edge), or just the first dep.
    const deps = graph.edges[cur] ?? [];
    const next = deps.find((d) => inDegree[d] > 0) ?? deps[0];
    if (!next) break;
    cur = next;
  }
  // Fallback (shouldn't reach here in well-formed graphs).
  return { kind: "cycle", cycle: path.map((k) => graph.nodes[k]!) };
}
