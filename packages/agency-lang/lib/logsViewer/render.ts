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
      viewport.cols,
    ),
  );
}

function renderRow(
  row: VisibleRow,
  isCursor: boolean,
  isExpanded: boolean,
  cols: number,
): string {
  const indent = "  ".repeat(row.depth);
  const glyph = chooseGlyph(row.node, isExpanded);
  const marker = isCursor ? "> " : "  ";
  const line = `${marker}${indent}${glyph} ${row.node.summary}`;
  // NOTE: v1 assumes ASCII-width summaries. `line.length` counts
  // UTF-16 code units, not terminal cells, so wide glyphs (CJK,
  // emoji) or combining marks will misalign / over-run the column
  // budget. Acceptable for v1 because summaries are built from a
  // fixed vocabulary plus short user payload fragments; revisit
  // with a string-width measurement if real users hit it.
  return line.length > cols ? line.slice(0, cols - 1) + "…" : line;
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
