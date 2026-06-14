import { describe, it, expect } from "vitest";
import { TreeNode } from "./treeNode.js";

const env = (o: object) =>
  JSON.stringify({
    format_version: 1, trace_id: "t1", project_id: "p", span_id: null,
    parent_span_id: null,
    data: { type: "agentStart", timestamp: "2026-06-14T00:00:00Z" }, ...o,
  });

describe("TreeNode.forestFromString", () => {
  it("builds a tree, hides graph events, and lazily fetches payloads", () => {
    const roots = TreeNode.forestFromString([
      env({ span_id: "s1", data: { type: "toolCall", timestamp: "2026-06-14T00:00:00Z", toolName: "grep", timeTaken: 12 } }),
      env({ span_id: "s1", data: { type: "graph", timestamp: "2026-06-14T00:00:00Z", nodes: [], edges: {}, startNode: "x" } }),
    ].join("\n"));
    expect(roots).toHaveLength(1);

    const labels: string[] = [];
    const walk = (n: TreeNode) => { labels.push(n.label); n.children.forEach(walk); };
    roots.forEach(walk);
    expect(labels).not.toContain("graph"); // graph hidden (view concern)
    expect(labels).toContain("toolCall");

    // event() lazily returns the underlying payload; never stored on the node.
    const findKind = (n: TreeNode, k: string): TreeNode | undefined =>
      n.nodeKind === k ? n : n.children.map((c) => findKind(c, k)).find(Boolean);
    const leaf = roots.map((r) => findKind(r, "event")).find(Boolean)!;
    expect(leaf.event()?.data.type).toBe("toolCall");
  });

  it("exposes file-level parse errors via any node", () => {
    const roots = TreeNode.forestFromString([env({}), "{ bad json"].join("\n"));
    expect(roots[0].parseErrors()).toHaveLength(1);
  });
});
