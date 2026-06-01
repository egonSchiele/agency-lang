import { describe, it, expect } from "vitest";
import type { InitDepGraph, InitVarNode } from "./initDepGraph.js";
import { makeKey } from "./initDepGraph.js";
import { topSortInitGraph } from "./topSortInitGraph.js";

/**
 * Build a minimal `InitDepGraph` from plain JS — no file system, no
 * parser. Each node is keyed by `${moduleId}::${varName}`. Optional
 * `hint` lets a test pin a node's `sequenceHint` directly, which is
 * the field the topsort uses to break ties between var-edge-unrelated
 * nodes. `kind` defaults to `"static"`; the topsort is graph-agnostic
 * — it runs the same way for the static and global graphs.
 */
function makeGraph(opts: {
  nodes: {
    module: string;
    name: string;
    kind?: "static" | "global";
    line?: number;
    hint?: number;
  }[];
  edges?: [string, string][];
}): InitDepGraph {
  const nodes: Record<string, InitVarNode> = {};
  for (const n of opts.nodes) {
    nodes[makeKey(n.module, n.name)] = {
      moduleId: n.module,
      varName: n.name,
      kind: n.kind ?? "static",
      initExpr: { type: "number", value: "0", loc: { line: 0, col: 0 } } as any,
      loc: { line: n.line ?? 0, col: 0, start: 0, end: 0 },
      exported: false,
      sequenceHint: n.hint ?? 0,
    };
  }
  const edges: Record<string, string[]> = {};
  for (const key of Object.keys(nodes)) edges[key] = [];
  for (const [a, b] of opts.edges ?? []) {
    edges[a] = [...(edges[a] ?? []), b];
  }
  return { nodes, edges };
}

describe("topSortInitGraph", () => {
  it("sorts a linear chain in dep-first order", () => {
    const g = makeGraph({
      nodes: [
        { module: "m", name: "a" },
        { module: "m", name: "b" },
        { module: "m", name: "c" },
      ],
      edges: [
        ["m::a", "m::b"],
        ["m::b", "m::c"],
      ],
    });
    const r = topSortInitGraph(g);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.order).toEqual(["m::c", "m::b", "m::a"]);
  });

  it("sorts a diamond — common ancestor first, root last", () => {
    const g = makeGraph({
      nodes: [
        { module: "m", name: "a" },
        { module: "m", name: "b" },
        { module: "m", name: "c" },
        { module: "m", name: "d" },
      ],
      edges: [
        ["m::a", "m::b"],
        ["m::a", "m::c"],
        ["m::b", "m::d"],
        ["m::c", "m::d"],
      ],
    });
    const r = topSortInitGraph(g);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.order[0]).toBe("m::d");
    expect(r.order[3]).toBe("m::a");
    expect(r.order.indexOf("m::b")).toBeGreaterThan(0);
    expect(r.order.indexOf("m::b")).toBeLessThan(3);
    expect(r.order.indexOf("m::c")).toBeGreaterThan(0);
    expect(r.order.indexOf("m::c")).toBeLessThan(3);
  });

  it("uses sequenceHint as the tiebreaker between unordered nodes", () => {
    // Two nodes with no var-edges between them; lower `hint` wins.
    const g = makeGraph({
      nodes: [
        { module: "/foo.agency", name: "fooStatic", hint: 1_000_000 },
        { module: "/bar.agency", name: "barStatic", hint: 0 },
      ],
    });
    const r = topSortInitGraph(g);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.order).toEqual([
      "/bar.agency::barStatic",
      "/foo.agency::fooStatic",
    ]);
  });

  it("reports a direct cycle as a CycleError", () => {
    const g = makeGraph({
      nodes: [
        { module: "/foo.agency", name: "fooStatic" },
        { module: "/bar.agency", name: "barStatic" },
      ],
      edges: [
        ["/foo.agency::fooStatic", "/bar.agency::barStatic"],
        ["/bar.agency::barStatic", "/foo.agency::fooStatic"],
      ],
    });
    const r = topSortInitGraph(g);
    expect(r.kind).toBe("cycle");
    if (r.kind !== "cycle") return;
    const names = r.cycle.map((n) => n.varName).sort();
    expect(names).toEqual(["barStatic", "fooStatic"]);
  });

  it("reports a 3-cycle naming all participants in cycle order", () => {
    // a → b → c → a. Whichever node we start from, the returned cycle
    // should include all 3 names.
    const g = makeGraph({
      nodes: [
        { module: "m", name: "a" },
        { module: "m", name: "b" },
        { module: "m", name: "c" },
      ],
      edges: [
        ["m::a", "m::b"],
        ["m::b", "m::c"],
        ["m::c", "m::a"],
      ],
    });
    const r = topSortInitGraph(g);
    expect(r.kind).toBe("cycle");
    if (r.kind !== "cycle") return;
    expect(r.cycle.length).toBe(3);
    const sortedNames = r.cycle.map((n) => n.varName).sort();
    expect(sortedNames).toEqual(["a", "b", "c"]);
    // The cycle should be consecutive: each node's deps should include
    // the next node, and the last should depend on the first.
    for (let i = 0; i < r.cycle.length; i++) {
      const cur = r.cycle[i];
      const next = r.cycle[(i + 1) % r.cycle.length];
      const curKey = makeKey(cur.moduleId, cur.varName);
      const nextKey = makeKey(next.moduleId, next.varName);
      expect(g.edges[curKey]).toContain(nextKey);
    }
  });

  it("returns only in-cycle nodes when a cycle node also depends on a drained DAG tail", () => {
    // Graph shape (X → Y means "X depends on Y"):
    //
    //   c1 → d1 → d2     (DAG tail — Kahn drains d2, then d1)
    //   c1 ↔ c2          (2-cycle — neither gets drained)
    //
    // `c1.deps = [d1, c2]` — the tail dep is listed FIRST so the
    // pre-fix code, which selects `deps.find(d => inDegree[d] > 0)`
    // against the PRE-Kahn inDegree map, picks `d1` (whose pre-Kahn
    // in-degree is 1) over `c2`. The walk then wanders into the
    // already-drained DAG portion (`d1 → d2`), exits the cycle, hits a
    // dead end, and returns `[c1, d1, d2]` as a "cycle" — including
    // two nodes that are not in any cycle at all.
    //
    // Post-fix `traceCycleFrom` consults the POST-Kahn `remaining`
    // map. `d1.remaining === 0` (Kahn drained it), so the walk picks
    // `c2` instead and the returned cycle is `[c1, c2]` — only the
    // genuinely in-cycle nodes.
    const g = makeGraph({
      nodes: [
        { module: "m", name: "c1" },
        { module: "m", name: "c2" },
        { module: "m", name: "d1" },
        { module: "m", name: "d2" },
      ],
      edges: [
        ["m::c1", "m::d1"],
        ["m::c1", "m::c2"],
        ["m::c2", "m::c1"],
        ["m::d1", "m::d2"],
      ],
    });
    const r = topSortInitGraph(g);
    expect(r.kind).toBe("cycle");
    if (r.kind !== "cycle") return;
    const names = r.cycle.map((n) => n.varName);
    expect(names).not.toContain("d1");
    expect(names).not.toContain("d2");
    const sorted = [...names].sort();
    expect(sorted).toEqual(["c1", "c2"]);
  });

  it("includes nodes from independent components in the output", () => {
    const g = makeGraph({
      nodes: [
        { module: "m", name: "a" },
        { module: "m", name: "b" },
        { module: "m", name: "c" },
        { module: "m", name: "d" },
      ],
      edges: [
        ["m::a", "m::b"],
        ["m::c", "m::d"],
      ],
    });
    const r = topSortInitGraph(g);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.order.length).toBe(4);
    expect(r.order.indexOf("m::b")).toBeLessThan(r.order.indexOf("m::a"));
    expect(r.order.indexOf("m::d")).toBeLessThan(r.order.indexOf("m::c"));
  });

  it("produces the same order across repeated sorts (deterministic)", () => {
    // Hint-distinct nodes with cross-component deps; rerunning the sort
    // should never change the output. Guards against accidental
    // Map/Set iteration-order leaks creeping back in.
    const g = makeGraph({
      nodes: [
        { module: "m1", name: "x", hint: 5 },
        { module: "m2", name: "y", hint: 1 },
        { module: "m3", name: "z", hint: 3 },
        { module: "m4", name: "w", hint: 4 },
      ],
      edges: [["m1::x", "m2::y"]],
    });
    const r1 = topSortInitGraph(g);
    const r2 = topSortInitGraph(g);
    expect(r1.kind).toBe("ok");
    expect(r2.kind).toBe("ok");
    if (r1.kind !== "ok" || r2.kind !== "ok") return;
    expect(r1.order).toEqual(r2.order);
  });

  it("topsorts a 50-module x 3-vars-each acyclic graph under 100ms", () => {
    // PR-2 perf smoke: confirms the per-round `ready.sort(byHint)` cost
    // is acceptable for realistic project sizes. Deterministically
    // generated (seeded RNG) so results are stable in CI.
    const MODULES = 50;
    const VARS_PER_MODULE = 3;
    const RAND_SEED = 0x9e3779b9;
    let seed = RAND_SEED;
    const rand = (): number => {
      // Mulberry32 — small, deterministic, fine for "pick a smaller
      // module index" decisions inside a perf fixture.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const nodes: { module: string; name: string; hint: number }[] = [];
    const edges: [string, string][] = [];
    for (let m = 0; m < MODULES; m++) {
      const mod = `m${m}`;
      for (let v = 0; v < VARS_PER_MODULE; v++) {
        nodes.push({
          module: mod,
          name: `v${v}`,
          hint: m * 1_000_000 + v,
        });
        // Each var randomly depends on 0–2 earlier-module vars; this
        // keeps the graph acyclic by construction (deps point to lower
        // module indices only).
        if (m === 0) continue;
        const depCount = Math.floor(rand() * 3);
        for (let d = 0; d < depCount; d++) {
          const depMod = Math.floor(rand() * m);
          const depVar = Math.floor(rand() * VARS_PER_MODULE);
          edges.push([`${mod}::v${v}`, `m${depMod}::v${depVar}`]);
        }
      }
    }
    const g = makeGraph({ nodes, edges });

    const start = performance.now();
    const r = topSortInitGraph(g);
    const elapsedMs = performance.now() - start;

    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.order.length).toBe(MODULES * VARS_PER_MODULE);
    expect(elapsedMs).toBeLessThan(100);
  });
});
