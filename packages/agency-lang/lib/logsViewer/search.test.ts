import { describe, it, expect } from "vitest";
import { findMatches, expandAncestorsOf, highlightMatches } from "./search.js";
import { TreeNode } from "./treeNode.js";
import type { ViewerState } from "./types.js";

function span(id: string, summary: string, children: TreeNode[] = [], parentId: string | null = null): TreeNode {
  return new TreeNode({
    id,
    traceId: "t",
    parentId,
    children,
    nodeKind: "span",
    label: id,
    summary,
  });
}

function trace(id: string, children: TreeNode[] = []): TreeNode {
  return new TreeNode({
    id,
    traceId: id,
    parentId: null,
    children,
    nodeKind: "trace",
    label: id,
    summary: `trace ${id}`,
  });
}

// A promptCompletion leaf built through the real model so node.event() resolves
// its payload lazily (the synthetic conversation/JSON rows are derived from it).
function pcForest(content: string): TreeNode[] {
  return TreeNode.forestFromString(
    JSON.stringify({
      format_version: 1,
      trace_id: "T",
      project_id: "p",
      span_id: null,
      parent_span_id: null,
      data: {
        type: "promptCompletion",
        timestamp: "2026-01-01T00:00:00Z",
        messages: [{ role: "user", content }],
      },
    }),
  );
}

describe("findMatches", () => {
  it("returns ids of nodes whose summary contains the query case-insensitively", () => {
    const t = trace("T", [
      span("a", "agentRun (1s)", [
        span("b", "llmCall (2s)"),
        span("c", "toolCall search"),
      ]),
    ]);
    expect(findMatches([t], "llm")).toEqual(["b"]);
    expect(findMatches([t], "LLM")).toEqual(["b"]);
  });

  it("returns ids in depth-first pre-order", () => {
    const t = trace("T", [
      span("a", "X", [span("b", "X"), span("c", "X")]),
      span("d", "X"),
    ]);
    expect(findMatches([t], "X")).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an empty list for an empty query", () => {
    const t = trace("T", [span("a", "anything")]);
    expect(findMatches([t], "")).toEqual([]);
  });

  it("returns an empty list when nothing matches", () => {
    const t = trace("T", [span("a", "alpha")]);
    expect(findMatches([t], "zzz")).toEqual([]);
  });
});

describe("expandAncestorsOf", () => {
  it("adds every ancestor of every match to expanded", () => {
    const c = span("c", "match");
    const b = span("b", "...", [c], "a");
    c.parentId = "b";
    const a = span("a", "...", [b], "T");
    b.parentId = "a";
    const t = trace("T", [a]);
    a.parentId = "T";
    const state: ViewerState = {
      roots: [t],
      expanded: new Set(),
      cursorId: "T",
      scrollTop: 0,
      quit: false,
    };
    const next = expandAncestorsOf(state, ["c"]);
    expect([...next.expanded].sort()).toEqual(["T", "a", "b"]);
  });

  it("returns the original state when there are no matches", () => {
    const state: ViewerState = {
      roots: [],
      expanded: new Set(),
      cursorId: "",
      scrollTop: 0,
      quit: false,
    };
    expect(expandAncestorsOf(state, [])).toBe(state);
  });
});

describe("findMatches — synthetic rows", () => {
  // A promptCompletion leaf whose conversation rows include "Alice".
  // findMatches must reach the synthetic convoLine, and expandAncestorsOf must
  // auto-expand the leaf so n/N lands on it.
  it("matches text inside synthetic conversation rows", () => {
    const roots = pcForest("Hello Alice");
    expect(findMatches(roots, "Alice")).toContain("evt-1:convo:0:0");
  });

  it("expands the parent leaf when a convo row matches", () => {
    const roots = pcForest("Hello Alice");
    const state: ViewerState = {
      roots,
      expanded: new Set(),
      cursorId: "trace-T",
      scrollTop: 0,
      quit: false,
    };
    const next = expandAncestorsOf(state, ["evt-1:convo:0"]);
    expect(next.expanded.has("evt-1")).toBe(true);
    expect(next.expanded.has("trace-T")).toBe(true);
  });

  it("expands both leaf and raw-data toggle for raw-JSON matches", () => {
    const roots = pcForest("Hello Alice");
    const state: ViewerState = {
      roots,
      expanded: new Set(),
      cursorId: "trace-T",
      scrollTop: 0,
      quit: false,
    };
    const next = expandAncestorsOf(state, ["evt-1:raw:json:5"]);
    expect(next.expanded.has("evt-1")).toBe(true);
    expect(next.expanded.has("evt-1:raw")).toBe(true);
  });
});

describe("highlightMatches", () => {
  it("returns one segment when the query is empty", () => {
    expect(highlightMatches("foo bar", "")).toEqual([{ text: "foo bar" }]);
  });

  it("marks the matching substring with bg yellow", () => {
    expect(highlightMatches("hello world", "wor")).toEqual([
      { text: "hello " },
      { text: "wor", bg: "yellow" },
      { text: "ld" },
    ]);
  });

  it("matches case-insensitively but preserves source case", () => {
    expect(highlightMatches("Hello", "ell")).toEqual([
      { text: "H" },
      { text: "ell", bg: "yellow" },
      { text: "o" },
    ]);
    expect(highlightMatches("Hello", "ELL")).toEqual([
      { text: "H" },
      { text: "ell", bg: "yellow" },
      { text: "o" },
    ]);
  });

  it("highlights multiple non-overlapping matches", () => {
    expect(highlightMatches("aaaa", "a")).toEqual([
      { text: "a", bg: "yellow" },
      { text: "a", bg: "yellow" },
      { text: "a", bg: "yellow" },
      { text: "a", bg: "yellow" },
    ]);
  });
});
