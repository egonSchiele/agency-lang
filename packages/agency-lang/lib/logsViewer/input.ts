import { ViewerState } from "./types.js";
import { flattenVisibleRows, VisibleRow } from "./render.js";

export type Key =
  | "j"
  | "k"
  | "h"
  | "l"
  | "g"
  | "G"
  | "q"
  | "Enter"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Ctrl+N"
  | "Ctrl+P"
  | "Ctrl+C"
  | string;

export function handleKey(state: ViewerState, key: Key): ViewerState {
  const rows = flattenVisibleRows(state);
  const idx = rows.findIndex((r) => r.node.id === state.cursorId);
  switch (key) {
    case "j":
    case "Down":
    case "Ctrl+N":
      return moveCursor(state, rows, Math.min(idx + 1, rows.length - 1));
    case "k":
    case "Up":
    case "Ctrl+P":
      return moveCursor(state, rows, Math.max(idx - 1, 0));
    case "g":
      return { ...state, cursorId: rows[0].node.id, scrollTop: 0 };
    case "G":
      return moveCursor(state, rows, rows.length - 1);
    case "l":
    case "Right":
    case "Enter":
      return expand(state, rows, idx);
    case "h":
    case "Left":
      return collapseOrParent(state, rows, idx);
    case "q":
    case "Ctrl+C":
      return { ...state, quit: true };
    default:
      return state;
  }
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
