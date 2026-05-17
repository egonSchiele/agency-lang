import { describe, it, expect } from "vitest";
import { buildJsonTree } from "./build.js";
import { defaultOpenSet } from "./render.js";
import { handlePaneKey, JsonPaneState, flattenJsonRows } from "./input.js";
import type { KeyEvent } from "../../tui/input/types.js";

const k = (key: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({
  key,
  ...mods,
});

function makeState(value: unknown, cursorPath = "$"): JsonPaneState {
  const root = buildJsonTree(value);
  return {
    root,
    open: defaultOpenSet(root),
    cursorPath,
    scrollTop: 0,
    releaseFocus: false,
  };
}

describe("handlePaneKey", () => {
  it("j moves cursor down to the next visible row", () => {
    const state = makeState({ a: 1, b: 2 });
    const next = handlePaneKey(state, k("j"));
    expect(next.cursorPath).toBe("$.a");
  });

  it("k moves cursor up", () => {
    const state = makeState({ a: 1, b: 2 }, "$.b");
    const next = handlePaneKey(state, k("k"));
    expect(next.cursorPath).toBe("$.a");
  });

  it("l on a closed container opens it", () => {
    const state = makeState({ a: { x: Array.from({ length: 20 }, (_, i) => i) } }, "$.a.x");
    expect(state.open.has("$.a.x")).toBe(false);
    const next = handlePaneKey(state, k("l"));
    expect(next.open.has("$.a.x")).toBe(true);
  });

  it("l on an already-open container descends to first child", () => {
    const state = makeState({ a: { x: 1, y: 2 } }, "$.a");
    expect(state.open.has("$.a")).toBe(true);
    const next = handlePaneKey(state, k("l"));
    expect(next.cursorPath).toBe("$.a.x");
  });

  it("h on an open container closes it", () => {
    const state = makeState({ a: { x: 1 } }, "$.a");
    expect(state.open.has("$.a")).toBe(true);
    const next = handlePaneKey(state, k("h"));
    expect(next.open.has("$.a")).toBe(false);
  });

  it("h on a closed container moves cursor to parent", () => {
    const state = makeState({ a: { x: 1, y: 2 } }, "$.a");
    // First close it.
    const closed: JsonPaneState = { ...state, open: new Set(["$"]) };
    const next = handlePaneKey(closed, k("h"));
    expect(next.cursorPath).toBe("$");
  });

  it("g jumps to the first row", () => {
    const state = makeState({ a: 1, b: 2 }, "$.b");
    const next = handlePaneKey(state, k("g"));
    expect(next.cursorPath).toBe("$");
  });

  it("G jumps to the last visible row", () => {
    const state = makeState({ a: 1, b: 2 });
    const next = handlePaneKey(state, k("G"));
    const rows = flattenJsonRows(state);
    expect(next.cursorPath).toBe(rows[rows.length - 1]);
  });

  it("Escape sets releaseFocus so the run loop hands focus back", () => {
    const state = makeState({ a: 1 });
    const next = handlePaneKey(state, k("escape"));
    expect(next.releaseFocus).toBe(true);
  });

  it("ignores unrelated keys", () => {
    const state = makeState({ a: 1 });
    const next = handlePaneKey(state, k("z"));
    expect(next).toBe(state);
  });
});
