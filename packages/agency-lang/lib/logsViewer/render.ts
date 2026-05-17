import { TreeNode, ViewerState } from "./types.js";

export type Viewport = { rows: number; cols: number };
export type VisibleRow = { node: TreeNode; depth: number };

export function flattenVisibleRows(state: ViewerState): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    out.push({ node, depth });
    if (state.expanded.has(node.id)) {
      for (const c of node.children) walk(c, depth + 1);
    }
  };
  for (const r of state.roots) walk(r, 0);
  return out;
}

export function renderViewerLines(
  state: ViewerState,
  viewport: Viewport,
): string[] {
  const rows = flattenVisibleRows(state);
  const slice = rows.slice(state.scrollTop, state.scrollTop + viewport.rows);
  return slice.map((row) =>
    renderRow(
      row,
      state.cursorId === row.node.id,
      state.expanded.has(row.node.id),
    ),
  );
}

function renderRow(
  row: VisibleRow,
  isCursor: boolean,
  isExpanded: boolean,
): string {
  const indent = "  ".repeat(row.depth);
  const glyph = chooseGlyph(row.node, isExpanded);
  const marker = isCursor ? "> " : "  ";
  // Over-long lines are clipped centrally by the TUI renderer; no
  // need to slice here.
  return `${marker}${indent}${glyph} ${row.node.summary}`;
}

function chooseGlyph(node: TreeNode, isExpanded: boolean): string {
  if (node.nodeKind === "event" || node.children.length === 0) return "●";
  return isExpanded ? "▼" : "▶";
}

// Per-row foreground color, keyed by span type for spans and event
// type for leaves. Returns undefined to mean "use the default
// terminal fg" — used for trace headers (which we'd rather see in
// the default color so the bold/inverse cursor style stays readable).
export function colorFor(node: TreeNode): string | undefined {
  if (node.nodeKind === "trace") return undefined;
  if (node.nodeKind === "span") {
    switch (node.label) {
      case "agentRun":
        return "bright-cyan";
      case "nodeExecution":
        return "bright-green";
      case "llmCall":
        return "bright-magenta";
      case "toolExecution":
        return "yellow";
      case "forkAll":
      case "race":
        return "magenta";
      case "handlerChain":
        return "bright-yellow";
      default:
        return undefined;
    }
  }
  // Leaf events: highlight the noisy ones, leave the rest default.
  switch (node.label) {
    case "error":
      return "bright-red";
    case "interruptThrown":
    case "interruptResolved":
      return "yellow";
    case "agentStart":
    case "agentEnd":
      return "cyan";
    default:
      return undefined;
  }
}
