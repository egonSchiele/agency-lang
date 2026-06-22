import { describe, it, expect } from "vitest";
import { findMatches, expandAncestorsOf, highlightMatches } from "./search.js";
import { buildForest } from "./tree.js";
import { EventEnvelope, TreeNode, ViewerState } from "./types.js";

function span(id: string, summary: string, children: TreeNode[] = [], parentId: string | null = null): TreeNode {
  return {
    id,
    traceId: "t",
    parentId,
    children,
    nodeKind: "span",
    label: id,
    summary,
  };
}

function trace(id: string, children: TreeNode[] = []): TreeNode {
  return {
    id,
    traceId: id,
    parentId: null,
    children,
    nodeKind: "trace",
    label: id,
    summary: `trace ${id}`,
  };
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
  // A promptCompletion leaf whose conversation rows include the word
  // "Alice". `findMatches` must reach the synthetic convoLine and
  // `expandAncestorsOf` must auto-expand the leaf so `n`/`N` lands
  // on it.
  function pcLeaf(): TreeNode {
    return {
      id: "evt-0",
      traceId: "T",
      parentId: "T",
      children: [],
      nodeKind: "event",
      label: "promptCompletion",
      summary: "promptCompletion",
      event: {
        format_version: 1,
        trace_id: "T",
        project_id: "p",
        span_id: null,
        parent_span_id: null,
        data: {
          type: "promptCompletion",
          timestamp: "2026-01-01T00:00:00Z",
          messages: [{ role: "user", content: "Hello Alice" }],
        },
      },
    };
  }

  it("matches text inside synthetic conversation rows", () => {
    const leaf = pcLeaf();
    const t = trace("T", [leaf]);
    leaf.parentId = "T";
    // "Alice" appears in the conversation row and again inside the
    // raw-data JSON payload, so we expect both synthetic ids.
    expect(findMatches([t], "Alice")).toContain("evt-0:convo:0:0");
  });

  it("expands the parent leaf when a convo row matches", () => {
    const leaf = pcLeaf();
    const t = trace("T", [leaf]);
    leaf.parentId = "T";
    const state: ViewerState = {
      roots: [t],
      expanded: new Set(),
      cursorId: "T",
      scrollTop: 0,
      quit: false,
    };
    const next = expandAncestorsOf(state, ["evt-0:convo:0"]);
    expect(next.expanded.has("evt-0")).toBe(true);
    expect(next.expanded.has("T")).toBe(true);
  });

  it("expands both leaf and raw-data toggle for raw-JSON matches", () => {
    const leaf = pcLeaf();
    const t = trace("T", [leaf]);
    leaf.parentId = "T";
    const state: ViewerState = {
      roots: [t],
      expanded: new Set(),
      cursorId: "T",
      scrollTop: 0,
      quit: false,
    };
    const next = expandAncestorsOf(state, ["evt-0:raw:json:5"]);
    expect(next.expanded.has("evt-0")).toBe(true);
    expect(next.expanded.has("evt-0:raw")).toBe(true);
  });
});

describe("findMatches — llmCall span flatten", () => {
  // A two-round tool call. The tool result + final answer ("551695")
  // appear only in the flattened conversation under the llmCall span,
  // not in any persistent forest node — search must still find them.
  const evt = (over: Partial<EventEnvelope>): EventEnvelope => ({
    format_version: 1,
    trace_id: "T",
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type: "debug", timestamp: "2026-06-21T00:00:00Z" },
    ...over,
  });

  const events: EventEnvelope[] = [
    evt({ span_id: "a", data: { type: "agentStart", timestamp: "2026-06-21T00:00:00Z" } }),
    evt({
      span_id: "L",
      parent_span_id: "a",
      data: {
        type: "promptCompletion",
        timestamp: "2026-06-21T00:00:01Z",
        messages: [{ role: "user", content: "area of France" }],
        completion: { output: null, toolCalls: [{ id: "c1", name: "getArea", arguments: {} }] },
      },
    }),
    evt({ span_id: "T", parent_span_id: "L", data: { type: "toolCall", timestamp: "2026-06-21T00:00:02Z", toolName: "getArea", output: "551695" } }),
    evt({
      span_id: "L",
      parent_span_id: "a",
      data: {
        type: "promptCompletion",
        timestamp: "2026-06-21T00:00:03Z",
        messages: [
          { role: "user", content: "area of France" },
          { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "getArea", arguments: {} }] },
          { role: "tool", name: "getArea", content: "551695", tool_call_id: "c1" },
        ],
        completion: { output: "The area is 551695", toolCalls: [] },
      },
    }),
  ];

  it("finds text that only exists in the flattened conversation", () => {
    const roots = buildForest(events);
    const matches = findMatches(roots, "551695");
    // At least one match is a convoLine synthetic id under the L span.
    expect(matches.some((id) => id.startsWith("L:llm:convo:"))).toBe(true);
  });

  it("expandAncestorsOf reveals a flattened-convo match by expanding the llmCall span", () => {
    const roots = buildForest(events);
    const state: ViewerState = {
      roots,
      expanded: new Set(),
      cursorId: roots[0].id,
      scrollTop: 0,
      quit: false,
    };
    const next = expandAncestorsOf(state, ["L:llm:convo:3:0"]);
    // The llmCall span itself and its ancestors (nodeExecution/agent
    // span + trace) are expanded so the convo row becomes visible.
    expect(next.expanded.has("L")).toBe(true);
    expect(next.expanded.has("a")).toBe(true);
    expect(next.expanded.has(roots[0].id)).toBe(true);
  });

  it("finds and reveals text inside a nested tool's llm() call", () => {
    const nested: EventEnvelope[] = [
      ...events.slice(0, 3),
      evt({
        span_id: "L2",
        parent_span_id: "T",
        data: {
          type: "promptCompletion",
          timestamp: "2026-06-21T00:00:025Z",
          messages: [{ role: "user", content: "compute area" }],
          completion: { output: "nested-answer-xyz", toolCalls: [] },
        },
      }),
      events[3],
    ];
    const roots = buildForest(nested);
    const matches = findMatches(roots, "nested-answer-xyz");
    expect(matches.some((id) => id.startsWith("L2:llm:convo:"))).toBe(true);
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
