import { describe, it, expect } from "vitest";
import type { InitDepGraph, InitVarNode } from "./initDepGraph.js";
import { makeKey } from "./initDepGraph.js";
import { topSortInitGraph } from "./topSortInitGraph.js";

/**
 * Build a minimal InitDepGraph from plain JS — no file system, no
 * parser. Each node is identified by `${moduleId}::${varName}`. The
 * helper short-circuits boilerplate so tests read as graph descriptions.
 */
function makeGraph(opts: {
  nodes: { module: string; name: string; kind?: "static" | "global"; line?: number }[];
  edges?: [string, string][];   // [key, dep] pairs
  fileImports?: Record<string, string[]>;
}): InitDepGraph {
  const nodes: Record<string, InitVarNode> = {};
  for (const n of opts.nodes) {
    nodes[makeKey(n.module, n.name)] = {
      moduleId: n.module,
      varName: n.name,
      kind: n.kind ?? "static",
      initExpr: { type: "number", value: "0", loc: { line: 0, col: 0 } } as any,
      loc: { line: n.line ?? 0, col: 0 },
      exported: false,
    };
  }
  const edges: Record<string, string[]> = {};
  for (const key of Object.keys(nodes)) edges[key] = [];
  for (const [a, b] of opts.edges ?? []) {
    edges[a] = [...(edges[a] ?? []), b];
  }
  return { nodes, edges, fileImports: opts.fileImports ?? {} };
}

describe("topSortInitGraph", () => {
  it("sorts a linear chain in dep-first order", () => {
    // a → b → c  (a depends on b, b depends on c)
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
    // a depends on b and c; both depend on d.
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
    // b and c can come in either order, but both must come after d
    // and before a.
    expect(r.order.indexOf("m::b")).toBeGreaterThan(0);
    expect(r.order.indexOf("m::b")).toBeLessThan(3);
    expect(r.order.indexOf("m::c")).toBeGreaterThan(0);
    expect(r.order.indexOf("m::c")).toBeLessThan(3);
  });

  it("uses file-import order as a tiebreaker (example 2 case)", () => {
    // foo and bar each have a static; no var-level edge between
    // them. foo's module imports bar's module. Expected: bar
    // initializes before foo.
    const g = makeGraph({
      nodes: [
        { module: "/foo.agency", name: "fooStatic" },
        { module: "/bar.agency", name: "barStatic" },
      ],
      fileImports: {
        "/foo.agency": ["/bar.agency"],
        "/bar.agency": [],
      },
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
    // foo → bar → foo
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

  it("reports a 3-cycle naming all participants", () => {
    // a → b → c → a
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
    const names = r.cycle.map((n) => n.varName).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("includes nodes from independent components in the output", () => {
    // Two disjoint chains: a→b and c→d. Both should appear.
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
});
