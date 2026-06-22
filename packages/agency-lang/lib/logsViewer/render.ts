import { TreeNode, ViewerState } from "./types.js";
import { summarizeSpanStyled, summarizeTraceStyled } from "./summary.js";
import { DEFAULT_THRESHOLDS, ViewerThresholds } from "./thresholds.js";
import { formatConversation } from "./conversation.js";

export type Viewport = { rows: number; cols: number };
export type VisibleRow = { node: TreeNode; depth: number };

export function flattenVisibleRows(state: ViewerState): VisibleRow[] {
  const out: VisibleRow[] = [];
  const cols = state.viewportCols;
  const walk = (node: TreeNode, depth: number): void => {
    out.push({ node, depth });
    if (!state.expanded.has(node.id)) return;
    // Leaf event nodes can be "expanded" to inline a synthetic
    // payload view (conversation lines for promptCompletion, raw
    // JSON otherwise). Real children only ever exist for non-leaf
    // tree nodes.
    if (node.nodeKind === "event" && node.event) {
      for (const child of eventExpansionChildren(node, depth + 1, cols)) {
        walk(child, depth + 1);
      }
      return;
    }
    // A "raw data" toggle row, when expanded, reveals the JSON
    // payload of the parent event leaf. We carry the original event
    // on the toggle node so we can recompute lines here.
    if (node.nodeKind === "rawDataToggle" && node.event) {
      for (const child of jsonLineChildren(node, node.event)) {
        walk(child, depth + 1);
      }
      return;
    }
    // An `llmCall` span renders its one-or-more rounds as a single
    // flattened conversation with tool executions spliced inline,
    // instead of listing its raw promptCompletion/toolExecution
    // children. See llmCallSpanChildren.
    if (node.nodeKind === "span" && node.label === "llmCall") {
      for (const child of llmCallSpanChildren(node, depth + 1, cols)) {
        walk(child, depth + 1);
      }
      return;
    }
    for (const c of node.children) walk(c, depth + 1);
  };
  for (const r of state.roots) walk(r, 0);
  return out;
}

// Return the synthetic children shown when a leaf event is expanded.
// promptCompletion events get a readable conversation view plus a
// "raw data" toggle for the JSON; other events fall back to raw JSON
// lines directly.
//
// Exported so search.ts can walk these the same way the renderer does
// — otherwise `/foo` would match a highlighted row but `n`/`N` would
// claim there are no matches (the rows aren't in the persistent
// forest).
export function eventExpansionChildren(
  leaf: TreeNode,
  // Depth at which the synthetic children will be rendered (= parent
  // event depth + 1). Used to compute available width when wrapping
  // long conversation lines.
  childDepth = 0,
  // Total terminal columns available; undefined disables wrapping
  // (tests, non-TTY contexts).
  cols?: number,
): TreeNode[] {
  if (!leaf.event) return [];
  if (leaf.event.data.type === "promptCompletion") {
    return promptCompletionChildren(leaf, childDepth, cols);
  }
  return jsonLineChildren(leaf, leaf.event);
}

// Synthetic children of a "raw data" toggle row. Exported for the
// same reason as eventExpansionChildren above.
export function rawDataChildren(toggle: TreeNode): TreeNode[] {
  if (!toggle.event) return [];
  return jsonLineChildren(toggle, toggle.event);
}

// Assemble the displayable transcript for a promptCompletion event:
// the request `messages` plus the assistant turn from `completion`.
// Render the assistant turn whenever it has text OR tool calls — the
// common tool-calling completion has `output: null` and a non-empty
// `toolCalls` array, and `formatConversation` already renders an
// assistant message's `toolCalls`, so we just pass them through.
function assembleTranscript(
  event: NonNullable<TreeNode["event"]>,
): any[] {
  const messages = Array.isArray(event.data.messages)
    ? event.data.messages
    : [];
  const completion = event.data.completion;
  const completionMessage: any[] = [];
  if (completion?.output || completion?.toolCalls?.length) {
    completionMessage.push({
      role: "assistant",
      content: completion.output,
      toolCalls: completion.toolCalls,
    });
  }
  return [...messages, ...completionMessage];
}

// Available text width for a synthetic child row at `childDepth`.
// renderRowText prefixes each row with `marker` (2 chars) + indent
// (`depth * 2` chars); subtract both so wrapped chunks fit without
// triggering the TUI clipper. Undefined cols (tests) disables wrapping.
function availableWidth(childDepth: number, cols?: number): number | undefined {
  return cols !== undefined ? Math.max(20, cols - childDepth * 2 - 2) : undefined;
}

// Turn one conversation line into one-or-more wrapped `convoLine` nodes.
function convoLineNodes(
  idPrefix: string,
  parent: TreeNode,
  line: string,
  lineIdx: number,
  available?: number,
): TreeNode[] {
  const chunks = available !== undefined ? wrapLine(line, available) : [line];
  return chunks.map((chunk, j) => ({
    id: `${idPrefix}:${lineIdx}:${j}`,
    traceId: parent.traceId,
    parentId: parent.id,
    children: [],
    nodeKind: "convoLine" as const,
    label: "",
    summary: chunk,
  }));
}

function rawDataToggleNode(
  id: string,
  parent: TreeNode,
  event: TreeNode["event"],
): TreeNode {
  return {
    id,
    traceId: parent.traceId,
    parentId: parent.id,
    children: [],
    nodeKind: "rawDataToggle" as const,
    label: "raw data",
    summary: "raw data",
    event,
  };
}

function promptCompletionChildren(
  leaf: TreeNode,
  childDepth = 0,
  cols?: number,
): TreeNode[] {
  const convoLines = formatConversation(assembleTranscript(leaf.event!));
  const available = availableWidth(childDepth, cols);
  const convoNodes: TreeNode[] = [];
  convoLines.forEach((line, i) => {
    convoNodes.push(...convoLineNodes(`${leaf.id}:convo`, leaf, line, i, available));
  });
  return [...convoNodes, rawDataToggleNode(`${leaf.id}:raw`, leaf, leaf.event)];
}

// Synthetic children shown when an `llmCall` span is expanded — the
// flattened, deduplicated conversation for one `llm()` call. Because a
// tool-loop's final round resends the whole growing thread, the LAST
// promptCompletion under the span holds the complete transcript; we
// render that and splice each `toolExecution` child span inline right
// after the assistant message whose tool calls triggered it (greedy by
// tool-call count, in time order — the tree already sorts children by
// time). The intermediate promptCompletion leaves are absorbed (their
// content is a prefix of the final transcript). A nested `llm()` inside
// a tool execution is itself an `llmCall` span, so it flattens
// recursively when its tool execution is expanded.
//
// Exported so search.ts walks the same rows the renderer shows.
export function llmCallSpanChildren(
  span: TreeNode,
  childDepth = 0,
  cols?: number,
): TreeNode[] {
  const pcLeaves = span.children.filter(
    (c) => c.event?.data.type === "promptCompletion",
  );
  // No promptCompletion under this span (e.g. the call errored before a
  // response). Fall back to the raw children so nothing is hidden.
  if (pcLeaves.length === 0) return span.children;

  // Under an llmCall span the only child SPANS are tool executions, so
  // match on nodeKind (robust to how the span happened to be labeled).
  const toolExecs = span.children.filter((c) => c.nodeKind === "span");
  const others = span.children.filter(
    (c) => !pcLeaves.includes(c) && !toolExecs.includes(c),
  );

  const last = pcLeaves[pcLeaves.length - 1];
  const transcript = assembleTranscript(last.event!);
  const available = availableWidth(childDepth, cols);

  const out: TreeNode[] = [];
  const queue = [...toolExecs];
  let lineIdx = 0;
  for (const msg of transcript) {
    for (const line of formatConversation([msg])) {
      out.push(...convoLineNodes(`${span.id}:llm:convo`, span, line, lineIdx++, available));
    }
    const toolCallCount = (msg?.toolCalls ?? msg?.tool_calls ?? []).length;
    for (let i = 0; i < toolCallCount && queue.length > 0; i++) {
      out.push(queue.shift()!);
    }
  }
  // Any tool executions or other children we couldn't place inline
  // (defensive — e.g. a count mismatch or an error event) go at the end
  // so nothing is silently dropped.
  out.push(...queue, ...others);
  // Raw-data toggle exposing the final promptCompletion envelope.
  out.push(rawDataToggleNode(`${span.id}:llm:raw`, span, last.event));
  return out;
}

// Word-aware hard wrap. Splits `text` into chunks of at most `width`
// code points, preferring to break at the last space at or before
// the limit. Words longer than `width` are split mid-word. Empty
// strings return [""] so a blank convoLine still occupies a row.
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    // No space found in the window — hard-break mid-word.
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut));
    // Drop the space we broke on (if any) so the next line doesn't
    // start with leading whitespace.
    rest = rest.slice(cut).replace(/^ +/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

// Pretty-print the leaf event payload and turn it into one synthetic
// TreeNode per line, so the visible-rows pipeline can fold them into
// the same scroll/cursor model used for real tree rows.
function jsonLineChildren(
  parent: TreeNode,
  envelope: NonNullable<TreeNode["event"]>,
): TreeNode[] {
  const text = JSON.stringify(envelope, null, 2);
  const lines = text.split("\n");
  return lines.map((line, i) => ({
    id: `${parent.id}:json:${i}`,
    traceId: parent.traceId,
    parentId: parent.id,
    children: [],
    nodeKind: "jsonLine" as const,
    label: "",
    summary: line,
  }));
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
  const marker = isCursor ? "> " : "  ";
  if (row.node.nodeKind === "jsonLine" || row.node.nodeKind === "convoLine") {
    // No glyph; the raw text line *is* the summary. Highlight
    // matches per the active search.
    const text = opts.query
      ? highlightInline(row.node.summary, opts.query)
      : row.node.summary;
    return `${marker}${indent}${text}`;
  }
  const glyph = chooseGlyph(row.node, isExpanded);
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
  if (node.nodeKind === "jsonLine" || node.nodeKind === "convoLine") return "";
  if (node.nodeKind === "rawDataToggle") return isExpanded ? "▼" : "▶";
  if (node.nodeKind === "event") {
    // Event leaves with a payload are expandable (inline JSON).
    if (node.event) return isExpanded ? "▼" : "▶";
    return "●";
  }
  if (node.children.length === 0) return "●";
  return isExpanded ? "▼" : "▶";
}

// Per-row foreground color, keyed by span type for spans and event
// type for leaves. Returns undefined to mean "use the default
// terminal fg" — used for trace headers (which we'd rather see in
// the default color so the bold/inverse cursor style stays readable).
export function colorFor(node: TreeNode): string | undefined {
  if (node.nodeKind === "jsonLine") return "gray";
  if (node.nodeKind === "rawDataToggle") return "gray";
  if (node.nodeKind === "convoLine") return undefined;
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
    case "toolCallStart":
    case "forkStart":
    case "forkEnd":
    case "forkBranchEnd":
    case "threadCreated":
    case "enterNode":
    case "exitNode":
      // Dim — the matching `toolCall` end event will carry full
      // duration/output and gets the louder default color. The start
      // event mostly matters when there is no end (killed mid-call).
      return "gray";
    case "agentStart":
    case "agentEnd":
      return "cyan";
    default:
      return undefined;
  }
}
