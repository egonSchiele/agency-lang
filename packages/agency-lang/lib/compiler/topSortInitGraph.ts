/**
 * Topological sort over a per-variable init dep graph (built by
 * `initDepGraph.ts`).
 *
 * On success: returns the init order — every node appears after all of
 * its deps. On a cycle in the variable graph: returns a structured
 * `CycleError` listing the cycle path so Task 3 can render a clean
 * compile-time error.
 *
 * Ordering rule: var-level edges always win. For nodes the edges leave
 * unordered, sort by each node's pre-computed `sequenceHint` (built
 * from the file-import-DAG depth + source line by the graph builder).
 * One ordering key, one consumer.
 *
 * Implementation: Kahn's algorithm; the "ready" bag is sorted by
 * sequenceHint between iterations. N (top-level decls in the closure)
 * is small enough that a per-round `.sort()` reads more clearly than a
 * hand-rolled priority queue.
 */

import type { InitDepGraph, InitVarKey, InitVarNode } from "./initDepGraph.js";

export type CycleError = {
  kind: "cycle";
  /** Representative cycle: each node depends on the next; the last
   * depends on the first. */
  cycle: InitVarNode[];
};

export type TopSortResult =
  | { kind: "ok"; order: InitVarKey[] }
  | CycleError;

export function topSortInitGraph(graph: InitDepGraph): TopSortResult {
  const { reverse, inDegree } = reverseEdges(graph);
  const { order, remaining } = kahn(graph, reverse, inDegree);
  if (order.length === Object.keys(graph.nodes).length) {
    return { kind: "ok", order };
  }
  // Pass the post-Kahn `remaining` map to the cycle tracer so it
  // restricts the starter and step selection to nodes that genuinely
  // still have unsatisfied deps (i.e., are in or feed into a cycle).
  // Using the pre-Kahn `inDegree` would let the trace wander into
  // already-drained DAG tails and return a non-cycle path as a "cycle."
  return { kind: "cycle", cycle: traceCycleFrom(graph, remaining) };
}

/**
 * Build the reverse adjacency (dep → dependents) and the per-node
 * in-degree count Kahn's algorithm consumes. The graph stores edges as
 * `node → its deps`; Kahn needs the opposite direction.
 */
function reverseEdges(graph: InitDepGraph): {
  reverse: Record<InitVarKey, InitVarKey[]>;
  inDegree: Record<InitVarKey, number>;
} {
  const reverse: Record<InitVarKey, InitVarKey[]> = {};
  const inDegree: Record<InitVarKey, number> = {};
  for (const key of Object.keys(graph.nodes)) {
    inDegree[key] = 0;
    reverse[key] = [];
  }
  for (const [key, deps] of Object.entries(graph.edges)) {
    for (const dep of deps) {
      if (inDegree[dep] === undefined) continue; // skip stale refs defensively
      reverse[dep].push(key);
      inDegree[key]++;
    }
  }
  return { reverse, inDegree };
}

/** Kahn's loop. Ready set is kept sorted by `sequenceHint` so the
 * output order is deterministic and matches the graph builder's
 * pre-computed ordering hints. */
function kahn(
  graph: InitDepGraph,
  reverse: Record<InitVarKey, InitVarKey[]>,
  inDegree: Record<InitVarKey, number>,
): { order: InitVarKey[]; remaining: Record<InitVarKey, number> } {
  const hintOf = (k: InitVarKey): number =>
    graph.nodes[k]?.sequenceHint ?? Number.POSITIVE_INFINITY;
  const byHint = (a: InitVarKey, b: InitVarKey): number => {
    const ha = hintOf(a);
    const hb = hintOf(b);
    if (ha !== hb) return ha - hb;
    return a < b ? -1 : a > b ? 1 : 0; // lex tiebreak — never reached if hints differ
  };

  // `remaining` is the per-node unsatisfied-deps count as Kahn drains
  // the graph. Returned alongside `order` so the caller can hand it
  // to `traceCycleFrom`: on a cycle, every drained node ends at 0 and
  // only cycle-side nodes retain a positive count.
  const remaining = { ...inDegree };
  const ready = Object.keys(remaining).filter((k) => remaining[k] === 0);
  ready.sort(byHint);

  const order: InitVarKey[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const dep of reverse[next] ?? []) {
      remaining[dep]--;
      if (remaining[dep] === 0) ready.push(dep);
    }
    ready.sort(byHint);
  }
  return { order, remaining };
}

/**
 * Find one representative cycle in `graph`. Called only when topsort
 * has confirmed a cycle exists (some node has remaining in-degree > 0).
 * Walks one outgoing edge at a time, preferring deps still in the
 * cycle, until we revisit a node — that closes the loop.
 *
 * `remaining` is the POST-Kahn in-degree map. Both the starter pick
 * and the next-step selection consult it so they only consider nodes
 * Kahn could not drain — i.e., nodes in or feeding into a cycle.
 * Restricting selection this way keeps the walk inside the cycle and
 * out of the DAG portion already drained by Kahn.
 */
function traceCycleFrom(
  graph: InitDepGraph,
  remaining: Record<InitVarKey, number>,
): InitVarNode[] {
  const start = Object.keys(remaining).find((k) => remaining[k] > 0);
  if (!start) return [];

  const path: InitVarKey[] = [];
  const positionOnPath: Record<InitVarKey, number> = {};
  let cur = start;
  const maxSteps = Object.keys(graph.nodes).length + 1;

  for (let i = 0; i < maxSteps; i++) {
    if (positionOnPath[cur] !== undefined) {
      return path.slice(positionOnPath[cur]).map((k) => graph.nodes[k]!);
    }
    positionOnPath[cur] = path.length;
    path.push(cur);
    const deps = graph.edges[cur] ?? [];
    const next = deps.find((d) => remaining[d] > 0) ?? deps[0];
    if (!next) break;
    cur = next;
  }
  return path.map((k) => graph.nodes[k]!);
}
