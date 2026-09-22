import { describe, expect, it } from "vitest";

import {
  ancestorsOf,
  buildTreeIndex,
  findNode,
  nearestAncestor,
  rootOf,
  walkNodes,
  walkWithDepth,
} from "./forest.js";
import { leaf, span, trace } from "./timeline/fixture.js";

const inner = span("llmCall", [leaf("promptCompletion", 300)], { id: "inner" });
const tool = span("toolExecution", [leaf("toolCallStart", 200), inner], { id: "tool" });
const sub = span("subprocessRun", [tool], { id: "sub" });
const root = trace([sub]);
const index = buildTreeIndex(root);

describe("walkNodes", () => {
  it("walks deeply nested logs without exhausting the call stack", () => {
    const completion = leaf("promptCompletion", 0);
    let deep = completion;
    const depth = 10000;
    for (let level = 0; level < depth; level++) {
      deep = span("toolExecution", [deep]);
    }
    expect(walkNodes(deep)).toHaveLength(depth + 1);
    const placed = walkWithDepth(deep);
    expect(placed).toHaveLength(depth);
    expect(placed.at(-1)).toMatchObject({ node: completion, depth: depth - 1 });
    const index = buildTreeIndex(deep);
    expect(ancestorsOf(completion, index)).toHaveLength(depth);
    expect(nearestAncestor(completion, index, (node) => node === deep)).toBe(deep);
    expect(rootOf(completion, index)).toBe(deep);
  });

  it("lists every node, parents before children", () => {
    const labels = walkNodes(root).map((node) => node.label);
    expect(labels).toEqual([
      "T",
      "subprocessRun",
      "toolExecution",
      "toolCallStart",
      "llmCall",
      "promptCompletion",
    ]);
  });
});

describe("findNode", () => {
  it("finds by id across roots, and returns undefined for a stranger", () => {
    expect(findNode([root], "inner")?.label).toBe("llmCall");
    expect(findNode([root], "nope")).toBeUndefined();
  });
});

describe("ancestors", () => {
  it("lists them nearest first", () => {
    expect(ancestorsOf(inner, index).map((node) => node.id)).toEqual(["tool", "sub", "trace-T"]);
  });

  it("finds the nearest one that passes a test", () => {
    const found = nearestAncestor(inner, index, (node) => node.label === "subprocessRun");
    expect(found?.id).toBe("sub");
  });

  it("the root of any node is the trace, and the trace is its own root", () => {
    expect(rootOf(inner, index).id).toBe("trace-T");
    expect(rootOf(root, index).id).toBe("trace-T");
  });
});
