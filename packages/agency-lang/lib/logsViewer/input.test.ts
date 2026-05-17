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
});
