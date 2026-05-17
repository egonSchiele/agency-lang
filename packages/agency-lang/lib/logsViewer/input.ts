import { ViewerState, TreeNode } from "./types.js";
import { flattenVisibleRows, VisibleRow } from "./render.js";
import type { KeyEvent } from "../tui/input/types.js";
import { formatKey } from "../tui/input/format.js";

export function handleKey(state: ViewerState, event: KeyEvent): ViewerState {
  const rows = flattenVisibleRows(state);
  if (rows.length === 0) return state;
  const idx = rows.findIndex((r) => r.node.id === state.cursorId);
  // `formatKey` returns canonical strings like "j", "G", "Up",
  // "Ctrl+C". It is case-preserving for single letters, so 'g' and
  // 'G' stay distinct here.
  switch (formatKey(event)) {
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
    case "e":
      return expandAll(state);
    case "E":
      return collapseAll(state);
    case "Tab":
      return cycleTrace(state, +1);
    case "Shift+Tab":
      return cycleTrace(state, -1);
    case "q":
    case "Ctrl+C":
      return { ...state, quit: true };
    default:
      return state;
  }
}

// Expand every span and trace in the forest. Leaves stay leaves.
function expandAll(state: ViewerState): ViewerState {
  const next = new Set(state.expanded);
  const walk = (node: TreeNode): void => {
    if (node.nodeKind !== "event") next.add(node.id);
    for (const c of node.children) walk(c);
  };
  for (const r of state.roots) walk(r);
  return { ...state, expanded: next };
}

// Collapse everything. Per the v1 default-expand-only-trace rule,
// auto-expand the lone trace when there is exactly one — keeps the
// "press E to see the top-level view" behavior intuitive.
function collapseAll(state: ViewerState): ViewerState {
  const onlyTrace = state.roots.length === 1 ? state.roots[0].id : undefined;
  const expanded = new Set<string>();
  if (onlyTrace !== undefined) expanded.add(onlyTrace);
  // Keep the cursor on something visible; if its node is now hidden,
  // move it to the trace root containing it (or the first trace).
  const cursorTraceRoot = traceRootOf(state.roots, state.cursorId);
  const cursorId = expanded.has(state.cursorId)
    ? state.cursorId
    : cursorTraceRoot ?? state.roots[0]?.id ?? state.cursorId;
  return { ...state, expanded, cursorId, scrollTop: 0 };
}

// Move the cursor to the previous/next trace root, wrapping at the
// edges. No-op when there's only one trace.
function cycleTrace(state: ViewerState, direction: 1 | -1): ViewerState {
  const traceIds = state.roots.map((r) => r.id);
  if (traceIds.length <= 1) return state;
  const cur = traceRootOf(state.roots, state.cursorId);
  const startIdx = cur ? traceIds.indexOf(cur) : -1;
  const nextIdx = (startIdx + direction + traceIds.length) % traceIds.length;
  return { ...state, cursorId: traceIds[nextIdx] };
}

function traceRootOf(roots: TreeNode[], id: string): string | undefined {
  for (const r of roots) {
    if (containsId(r, id)) return r.id;
  }
  return undefined;
}

function containsId(node: TreeNode, id: string): boolean {
  if (node.id === id) return true;
  for (const c of node.children) {
    if (containsId(c, id)) return true;
  }
  return false;
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
