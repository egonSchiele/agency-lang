import { describe, it, expect } from "vitest";
import { handleKey } from "./input.js";
import { ViewerState, TreeNode } from "./types.js";
import type { KeyEvent } from "../tui/input/types.js";

const k = (key: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({ key, ...mods });

const child = (id: string): TreeNode => ({
  id,
  traceId: "t",
  parentId: "trace-t",
  children: [],
  nodeKind: "span",
  label: id,
  summary: id,
});

const initial = (cursorId = "trace-t"): ViewerState => ({
  roots: [
    {
      id: "trace-t",
      traceId: "t",
      parentId: null,
      children: [child("a"), child("b")],
      nodeKind: "trace",
      label: "t",
      summary: "trace t",
    },
  ],
  expanded: new Set(["trace-t"]),
  cursorId,
  scrollTop: 0,
  quit: false,
});

describe("handleKey", () => {
  it("j moves cursor down", () => {
    const next = handleKey(initial("trace-t"), k("j"));
    expect(next.cursorId).toBe("a");
  });

  it("k moves cursor up", () => {
    const next = handleKey(initial("a"), k("k"));
    expect(next.cursorId).toBe("trace-t");
  });

  it("q sets quit", () => {
    const next = handleKey(initial(), k("q"));
    expect(next.quit).toBe(true);
  });

  it("l expands a collapsed node with children", () => {
    // Add children to `a` so it can be expanded.
    const state = initial("a");
    state.roots[0].children[0] = {
      ...child("a"),
      children: [child("a-child")],
    };
    state.expanded.delete("a");
    const next = handleKey(state, k("l"));
    expect(next.expanded.has("a")).toBe(true);
  });

  it("h collapses an expanded node", () => {
    const state = initial("trace-t");
    expect(state.expanded.has("trace-t")).toBe(true);
    const next = handleKey(state, k("h"));
    expect(next.expanded.has("trace-t")).toBe(false);
  });

  it("h on a collapsed node moves cursor to parent", () => {
    const state = initial("a");
    expect(state.expanded.has("a")).toBe(false);
    const next = handleKey(state, k("h"));
    expect(next.cursorId).toBe("trace-t");
  });

  it("g jumps to the first visible row", () => {
    const next = handleKey(initial("a"), k("g"));
    expect(next.cursorId).toBe("trace-t");
    expect(next.scrollTop).toBe(0);
  });

  it("G jumps to the last visible row", () => {
    const next = handleKey(initial("trace-t"), k("G"));
    expect(next.cursorId).toBe("b");
  });

  it("l on an already-expanded node descends to its first child", () => {
    const next = handleKey(initial("trace-t"), k("l"));
    expect(next.cursorId).toBe("a");
    expect(next.expanded.has("trace-t")).toBe(true);
  });

  it("returns state unchanged on any key when there are no visible rows", () => {
    const empty: ViewerState = {
      roots: [],
      expanded: new Set(),
      cursorId: "",
      scrollTop: 0,
      quit: false,
    };
    expect(handleKey(empty, k("j"))).toBe(empty);
    expect(handleKey(empty, k("g"))).toBe(empty);
    expect(handleKey(empty, k("G"))).toBe(empty);
  });

  it("Ctrl+C also quits", () => {
    const next = handleKey(initial(), k("c", { ctrl: true }));
    expect(next.quit).toBe(true);
  });

  it("arrow keys move cursor", () => {
    const next = handleKey(initial("trace-t"), k("down"));
    expect(next.cursorId).toBe("a");
  });

  // Tree: trace-t → [a → [a-child], b → [b-child]], all spans, with only
  // the trace expanded. Used for the subtree expand/collapse tests.
  const nested = (cursorId: string, expanded: string[] = ["trace-t"]): ViewerState => ({
    roots: [
      {
        id: "trace-t",
        traceId: "t",
        parentId: null,
        nodeKind: "trace",
        label: "t",
        summary: "trace t",
        children: [
          { ...child("a"), parentId: "trace-t", children: [{ ...child("a-child"), parentId: "a" }] },
          { ...child("b"), parentId: "trace-t", children: [{ ...child("b-child"), parentId: "b" }] },
        ],
      },
    ],
    expanded: new Set(expanded),
    cursorId,
    scrollTop: 0,
    quit: false,
  });

  it("e expands the node under the cursor and all of its descendants only", () => {
    const next = handleKey(nested("a"), k("e"));
    expect(next.expanded.has("a")).toBe(true);
    expect(next.expanded.has("a-child")).toBe(true);
    // Sibling 'b' (and its child) are NOT touched — the expand is scoped.
    expect(next.expanded.has("b")).toBe(false);
    expect(next.expanded.has("b-child")).toBe(false);
  });

  it("e on the root expands its whole subtree", () => {
    const next = handleKey(nested("trace-t"), k("e"));
    for (const id of ["trace-t", "a", "a-child", "b", "b-child"]) {
      expect(next.expanded.has(id)).toBe(true);
    }
  });

  it("E collapses the current node and its descendants, leaving siblings", () => {
    const state = nested("a", ["trace-t", "a", "a-child", "b", "b-child"]);
    const next = handleKey(state, k("E"));
    expect(next.expanded.has("a")).toBe(false);
    expect(next.expanded.has("a-child")).toBe(false);
    // Sibling subtree stays expanded; cursor stays on the collapsed node.
    expect(next.expanded.has("b")).toBe(true);
    expect(next.expanded.has("b-child")).toBe(true);
    expect(next.expanded.has("trace-t")).toBe(true);
    expect(next.cursorId).toBe("a");
  });

  it("z expands every span and trace in the whole forest, regardless of cursor", () => {
    // Cursor on a leaf-most node, but z still expands the entire forest.
    const next = handleKey(nested("a"), k("z"));
    for (const id of ["trace-t", "a", "a-child", "b", "b-child"]) {
      expect(next.expanded.has(id)).toBe(true);
    }
  });

  it("Z collapses the whole forest, auto-expanding the lone trace", () => {
    const state = nested("a", ["trace-t", "a", "a-child", "b", "b-child"]);
    const next = handleKey(state, k("Z"));
    expect(next.expanded.has("a")).toBe(false);
    expect(next.expanded.has("b")).toBe(false);
    expect(next.expanded.has("trace-t")).toBe(true); // lone trace stays expanded
  });

  it("Tab cycles to the next trace root", () => {
    const state: ViewerState = {
      roots: [
        { ...child("t1"), id: "t1", nodeKind: "trace", traceId: "t1", parentId: null, summary: "t1" },
        { ...child("t2"), id: "t2", nodeKind: "trace", traceId: "t2", parentId: null, summary: "t2" },
        { ...child("t3"), id: "t3", nodeKind: "trace", traceId: "t3", parentId: null, summary: "t3" },
      ],
      expanded: new Set(),
      cursorId: "t1",
      scrollTop: 0,
      quit: false,
    };
    const next = handleKey(state, k("tab"));
    expect(next.cursorId).toBe("t2");
    const wrapped = handleKey({ ...state, cursorId: "t3" }, k("tab"));
    expect(wrapped.cursorId).toBe("t1");
  });

  it("Shift+Tab cycles to the previous trace root", () => {
    const state: ViewerState = {
      roots: [
        { ...child("t1"), id: "t1", nodeKind: "trace", traceId: "t1", parentId: null, summary: "t1" },
        { ...child("t2"), id: "t2", nodeKind: "trace", traceId: "t2", parentId: null, summary: "t2" },
      ],
      expanded: new Set(),
      cursorId: "t1",
      scrollTop: 0,
      quit: false,
    };
    const next = handleKey(state, k("tab", { shift: true }));
    expect(next.cursorId).toBe("t2"); // wraps backwards
  });

  it("Tab is a no-op when there is only one trace", () => {
    const state = initial();
    expect(handleKey(state, k("tab"))).toBe(state);
  });
});
