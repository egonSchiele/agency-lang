import type { KeyEvent } from "../../tui/input/types.js";
import { formatKey } from "../../tui/input/format.js";
import { JsonNode } from "./types.js";
import { renderJson } from "./render.js";

// The pane's own state: which paths are open, where the cursor is,
// and how far we've scrolled. Owned by the outer ViewerState; this
// module only knows how to mutate it.
export type JsonPaneState = {
  root: JsonNode;
  open: Set<string>;
  cursorPath: string;
  scrollTop: number;
  // Set to true when Esc was pressed so the run loop knows to hand
  // focus back to the outer tree.
  releaseFocus: boolean;
};

// Compute the cursor-eligible paths in display order. We pin focus
// onto whatever the renderer emits a `> `-eligible line for: every
// node owns one such line. We re-derive this from the tree + open
// state instead of caching to keep the state shape narrow.
export function flattenJsonRows(state: JsonPaneState): string[] {
  return renderJson(state.root, { open: state.open, cursorPath: state.cursorPath })
    .map((l) => l.ownerPath)
    // Each container produces an open AND a close line with the
    // same ownerPath; the cursor is allowed only on the first
    // appearance (the open line).
    .filter((p, i, arr) => arr.indexOf(p) === i);
}

export function handlePaneKey(
  state: JsonPaneState,
  event: KeyEvent,
): JsonPaneState {
  const rows = flattenJsonRows(state);
  if (rows.length === 0) return state;
  const idx = Math.max(0, rows.indexOf(state.cursorPath));
  switch (formatKey(event)) {
    case "j":
    case "Down":
      return moveCursor(state, rows, Math.min(idx + 1, rows.length - 1));
    case "k":
    case "Up":
      return moveCursor(state, rows, Math.max(idx - 1, 0));
    case "g":
      return { ...state, cursorPath: rows[0], scrollTop: 0 };
    case "G":
      return moveCursor(state, rows, rows.length - 1);
    case "l":
    case "Right":
    case "Enter":
      return expand(state);
    case "h":
    case "Left":
      return collapseOrParent(state);
    case "Escape":
      return { ...state, releaseFocus: true };
    default:
      return state;
  }
}

function moveCursor(
  state: JsonPaneState,
  rows: string[],
  newIdx: number,
): JsonPaneState {
  if (newIdx < 0 || newIdx >= rows.length) return state;
  return { ...state, cursorPath: rows[newIdx] };
}

function expand(state: JsonPaneState): JsonPaneState {
  const node = findByPath(state.root, state.cursorPath);
  if (!node || !canExpand(node)) return state;
  if (state.open.has(node.path)) {
    // Already open: descend into the first child.
    const first = firstChildPath(node);
    return first ? { ...state, cursorPath: first } : state;
  }
  const open = new Set(state.open);
  open.add(node.path);
  return { ...state, open };
}

function collapseOrParent(state: JsonPaneState): JsonPaneState {
  const node = findByPath(state.root, state.cursorPath);
  if (!node) return state;
  if (state.open.has(node.path)) {
    const open = new Set(state.open);
    open.delete(node.path);
    return { ...state, open };
  }
  const parent = parentPath(node.path);
  return parent ? { ...state, cursorPath: parent } : state;
}

function canExpand(node: JsonNode): boolean {
  return node.kind === "object" || node.kind === "array" || node.kind === "longString";
}

function firstChildPath(node: JsonNode): string | undefined {
  if (node.kind === "object" && node.entries.length > 0) {
    return node.entries[0].child.path;
  }
  if (node.kind === "array" && node.items.length > 0) {
    return node.items[0].path;
  }
  return undefined;
}

function parentPath(path: string): string | undefined {
  if (path === "$") return undefined;
  // Strip the last "[...]" or ".key" segment.
  const m = path.match(/^(.*)(\.[^.\[]+|\[\d+\])$/);
  return m ? m[1] : undefined;
}

export function findByPath(root: JsonNode, path: string): JsonNode | undefined {
  if (root.path === path) return root;
  if (root.kind === "object") {
    for (const { child } of root.entries) {
      const hit = findByPath(child, path);
      if (hit) return hit;
    }
  } else if (root.kind === "array") {
    for (const item of root.items) {
      const hit = findByPath(item, path);
      if (hit) return hit;
    }
  }
  return undefined;
}
