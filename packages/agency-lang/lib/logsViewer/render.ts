import { TreeNode, ViewerState } from "./types.js";
import { summarizeSpanStyled, summarizeTraceStyled } from "./summary.js";
import { DEFAULT_THRESHOLDS, ViewerThresholds } from "./thresholds.js";

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
    renderRowText(
      row,
      state.cursorId === row.node.id,
      state.expanded.has(row.node.id),
    ),
  );
}

export function renderRowText(
  row: VisibleRow,
  isCursor: boolean,
  isExpanded: boolean,
  opts: { query?: string; thresholds?: ViewerThresholds } = {},
): string {
  const indent = "  ".repeat(row.depth);
  const glyph = chooseGlyph(row.node, isExpanded);
  const marker = isCursor ? "> " : "  ";
  // Spans and traces get the magnitude-colored summary so durations
  // and costs render in red/gray per the configured thresholds; raw
  // event leaves use the plain pre-computed summary (no metrics).
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const styledSummary =
    row.node.nodeKind === "span"
      ? summarizeSpanStyled(row.node, t)
      : row.node.nodeKind === "trace"
        ? summarizeTraceStyled(row.node, t)
        : row.node.summary;
  const withHighlight = opts.query
    ? highlightInline(styledSummary, opts.query)
    : styledSummary;
  // Over-long lines are clipped centrally by the TUI renderer; no
  // need to slice here.
  return `${marker}${indent}${glyph} ${withHighlight}`;
}

// Wrap every case-insensitive occurrence of `query` in the source
// string with `{yellow-bg}...{/yellow-bg}` style tags, taking care
// not to break existing tags that the styled summary may already
// have inserted (e.g. `{bright-red-fg}5.2s{/bright-red-fg}`). We
// only highlight substrings that fall fully outside a tag body.
export function highlightInline(text: string, query: string): string {
  if (!query) return text;
  const needle = query.toLowerCase();
  // Walk through the source one segment at a time, splitting at any
  // `{...}` tag boundary. Highlight inside text segments only.
  const parts = splitOnTags(text);
  const out: string[] = [];
  for (const part of parts) {
    if (part.kind === "tag") {
      out.push(part.text);
      continue;
    }
    let i = 0;
    const lower = part.text.toLowerCase();
    while (i < part.text.length) {
      const hit = lower.indexOf(needle, i);
      if (hit < 0) {
        out.push(part.text.slice(i));
        break;
      }
      if (hit > i) out.push(part.text.slice(i, hit));
      out.push(`{yellow-bg}${part.text.slice(hit, hit + query.length)}{/yellow-bg}`);
      i = hit + query.length;
    }
  }
  return out.join("");
}

type Part = { kind: "text" | "tag"; text: string };

function splitOnTags(text: string): Part[] {
  const re = /\{[^}]+\}/g;
  const out: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "tag", text: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
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
