import { ViewerState } from "./types.js";
import { flattenVisibleRows, VisibleRow } from "./render.js";
import type { KeyEvent } from "../tui/input/types.js";
import { keyMatches } from "../tui/input/format.js";

// `keyMatches` is intentionally case-insensitive so callers can use
// "up" or "Up" interchangeably. Vim-style letter shortcuts ('g' vs
// 'G') need case-sensitive matching though, so for the single-letter
// keys we compare event.key directly.
function letter(event: KeyEvent, ch: string): boolean {
  return !event.ctrl && !event.shift && event.key === ch;
}

export function handleKey(state: ViewerState, event: KeyEvent): ViewerState {
  const rows = flattenVisibleRows(state);
  if (rows.length === 0) return state;
  const idx = rows.findIndex((r) => r.node.id === state.cursorId);
  if (letter(event, "j") || keyMatches(event, "Down") || keyMatches(event, "Ctrl+N")) {
    return moveCursor(state, rows, Math.min(idx + 1, rows.length - 1));
  }
  if (letter(event, "k") || keyMatches(event, "Up") || keyMatches(event, "Ctrl+P")) {
    return moveCursor(state, rows, Math.max(idx - 1, 0));
  }
  if (letter(event, "g")) {
    return { ...state, cursorId: rows[0].node.id, scrollTop: 0 };
  }
  if (event.key === "G" && !event.ctrl) {
    return moveCursor(state, rows, rows.length - 1);
  }
  if (letter(event, "l") || keyMatches(event, "Right") || keyMatches(event, "Enter")) {
    return expand(state, rows, idx);
  }
  if (letter(event, "h") || keyMatches(event, "Left")) {
    return collapseOrParent(state, rows, idx);
  }
  if (letter(event, "q") || keyMatches(event, "Ctrl+C")) {
    return { ...state, quit: true };
  }
  return state;
}

function moveCursor(
  state: ViewerState,
  rows: VisibleRow[],
  newIdx: number,
): ViewerState {
  if (newIdx < 0 || newIdx >= rows.length) return state;
  return { ...state, cursorId: rows[newIdx].node.id };
}

function expand(
  state: ViewerState,
  rows: VisibleRow[],
  idx: number,
): ViewerState {
  if (idx < 0) return state;
  const node = rows[idx].node;
  if (node.children.length === 0) return state;
  // If the node is already expanded, descend into its first child.
  if (state.expanded.has(node.id)) {
    return { ...state, cursorId: node.children[0].id };
  }
  const next = new Set(state.expanded);
  next.add(node.id);
  return { ...state, expanded: next };
}

function collapseOrParent(
  state: ViewerState,
  rows: VisibleRow[],
  idx: number,
): ViewerState {
  if (idx < 0) return state;
  const node = rows[idx].node;
  if (state.expanded.has(node.id)) {
    const next = new Set(state.expanded);
    next.delete(node.id);
    return { ...state, expanded: next };
  }
  if (node.parentId) {
    return { ...state, cursorId: node.parentId };
  }
  return state;
}
