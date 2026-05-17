import { Screen } from "../tui/screen.js";
import { column, line, lines } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import type { InputSource } from "../tui/input/types.js";
import type { OutputTarget } from "../tui/output/types.js";
import { clampScroll, followCursor } from "../tui/scroll.js";
import { scrollList } from "../tui/scrollList.js";
import { parseStatelogJsonl } from "./parse.js";
import { buildForest } from "./tree.js";
import {
  flattenVisibleRows,
  colorFor,
  renderRowText,
  VisibleRow,
} from "./render.js";
import { handleKeyEx } from "./input.js";
import { handlePaneKey, flattenJsonRows } from "./jsonView/input.js";
import { buildJsonTree } from "./jsonView/build.js";
import { defaultOpenSet, renderJson } from "./jsonView/render.js";
import { ViewerState, TreeNode, JsonPaneStateRef } from "./types.js";
import { findMatches, expandAncestorsOf } from "./search.js";
import { detectClipboard } from "./clipboard.js";
import { follow, Follower } from "./follow.js";
import { helpLines } from "./help.js";
import { DEFAULT_THRESHOLDS, ViewerThresholds } from "./thresholds.js";

export type RunViewerOpts = {
  jsonl: string;
  input: InputSource;
  output: OutputTarget;
  viewport: { rows: number; cols: number };
  // Optional path to enable --follow mode (re-read as the file grows).
  // Undefined disables follow even if the user presses `f`.
  followPath?: string;
  thresholds?: ViewerThresholds;
};

export async function runViewer(opts: RunViewerOpts): Promise<void> {
  const parsed = parseStatelogJsonl(opts.jsonl);
  const roots = buildForest(parsed.events);

  const screen = new Screen({
    input: opts.input,
    output: opts.output,
    width: opts.viewport.cols,
    height: opts.viewport.rows,
  });

  if (roots.length === 0) {
    screen.render(lines(["No events found."]));
    await opts.input.nextKey();
    return;
  }

  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  let state: ViewerState = applyScroll(
    {
      roots,
      // Default-expand the only trace if there is exactly one.
      expanded: new Set(roots.length === 1 ? [roots[0].id] : []),
      cursorId: roots[0].id,
      scrollTop: 0,
      quit: false,
      pane: "tree",
    },
    opts.viewport,
  );

  // Follow mode book-keeping. The watcher is started/stopped lazily
  // when the user toggles `f`. We re-parse the *whole* JSONL on each
  // append — simpler than incremental and the file is usually tiny.
  let followerState: { f: Follower; jsonl: string } | undefined;
  const startFollow = (): void => {
    if (!opts.followPath || followerState) return;
    let accum = opts.jsonl;
    followerState = {
      jsonl: accum,
      f: follow({
        path: opts.followPath,
        onAppend: (chunk) => {
          accum += chunk;
          if (followerState) followerState.jsonl = accum;
          state = onFollowAppend(state, accum, opts.viewport);
          screen.render(renderState(state, parsed.errors, opts.viewport, thresholds));
        },
      }),
    };
  };
  const stopFollow = (): void => {
    if (!followerState) return;
    followerState.f.stop();
    followerState = undefined;
  };

  screen.render(renderState(state, parsed.errors, opts.viewport, thresholds));
  try {
    while (!state.quit) {
      const event = await screen.nextKey();
      // Global quit, regardless of which pane has focus.
      if (
        event.key === "q" ||
        (event.ctrl && (event.key === "c" || event.key === "C"))
      ) {
        state = { ...state, quit: true };
        break;
      }
      // JSON pane has focus: route keys there.
      if (state.pane === "json" && state.jsonPane) {
        const builtFor = state.jsonPane.builtFor;
        const nextJson = handlePaneKey(state.jsonPane, event);
        if (nextJson.releaseFocus) {
          state = {
            ...state,
            pane: "tree",
            jsonPane: { ...nextJson, releaseFocus: false, builtFor },
          };
        } else {
          state = { ...state, jsonPane: { ...nextJson, builtFor } };
        }
      } else {
        const { state: next, command } = handleKeyEx(state, event);
        state = applyScroll(next, opts.viewport);
        if (command?.kind === "search") {
          const query = await screen.nextLine("Search: ");
          state = applySearch(state, query, opts.viewport);
        } else if (command?.kind === "copy") {
          state = runCopy(state);
        } else if (command?.kind === "toggleFollow") {
          state = runToggleFollow(state, opts.followPath, startFollow, stopFollow);
        }
      }
      // Maintain the JSON pane: rebuild content when the focused
      // tree leaf changes, drop it when the pane is closed.
      state = syncJsonPane(state);
      state = applyScroll(state, opts.viewport);
      screen.render(renderState(state, parsed.errors, opts.viewport, thresholds));
    }
  } finally {
    stopFollow();
  }
}

// Build / rebuild / clear the inner JSON pane based on the current
// focused tree node. Cheap to call on every key — the JSON tree is
// only re-built when the focused-node id actually changed.
function syncJsonPane(state: ViewerState): ViewerState {
  if (!state.jsonPaneOpen) {
    return state.jsonPane ? { ...state, jsonPane: undefined } : state;
  }
  if (state.jsonPane?.builtFor === state.cursorId) return state;
  const node = findNode(state.roots, state.cursorId);
  if (!node) return state;
  const payload = jsonPayloadFor(node);
  const root = buildJsonTree(payload);
  const open = defaultOpenSet(root);
  const pane: JsonPaneStateRef = {
    root,
    open,
    cursorPath: root.path,
    scrollTop: 0,
    releaseFocus: false,
    builtFor: state.cursorId,
  };
  return { ...state, jsonPane: pane };
}

// JSON payload for a tree node. Leaves serialize their EventEnvelope;
// spans and traces synthesize a small summary object because spans
// don't have one canonical payload (multiple events share a span).
function jsonPayloadFor(node: TreeNode): unknown {
  if (node.nodeKind === "event" && node.event) return node.event;
  if (node.nodeKind === "span") {
    return {
      spanType: node.label,
      spanId: node.id,
      parentId: node.parentId,
      metrics: {
        duration: node.duration,
        tokens: node.tokens,
        cost: node.cost,
      },
      eventCount: countEvents(node),
    };
  }
  // trace
  return {
    traceId: node.traceId,
    metrics: {
      duration: node.duration,
      tokens: node.tokens,
      cost: node.cost,
    },
    eventCount: countEvents(node),
  };
}

function countEvents(node: TreeNode): number {
  let n = node.nodeKind === "event" ? 1 : 0;
  for (const c of node.children) n += countEvents(c);
  return n;
}

function findNode(roots: TreeNode[], id: string): TreeNode | undefined {
  const stack: TreeNode[] = [...roots];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    for (const c of n.children) stack.push(c);
  }
  return undefined;
}

function applySearch(
  state: ViewerState,
  query: string,
  viewport: { rows: number; cols: number },
): ViewerState {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ...state, query: undefined, matches: undefined, matchIdx: undefined };
  }
  const matches = findMatches(state.roots, trimmed);
  if (matches.length === 0) {
    return {
      ...state,
      query: trimmed,
      matches: [],
      matchIdx: undefined,
      messageBar: `no matches for "${trimmed}"`,
    };
  }
  const withAncestors = expandAncestorsOf(state, matches);
  const jumped: ViewerState = {
    ...withAncestors,
    query: trimmed,
    matches,
    matchIdx: 0,
    cursorId: matches[0],
  };
  return applyScroll(jumped, viewport);
}

function runToggleFollow(
  state: ViewerState,
  followPath: string | undefined,
  start: () => void,
  stop: () => void,
): ViewerState {
  if (!followPath) {
    return { ...state, messageBar: "follow disabled (stdin or no file)" };
  }
  if (state.followOn) {
    stop();
    return { ...state, followOn: false, messageBar: "follow off" };
  }
  start();
  return { ...state, followOn: true, messageBar: "follow on" };
}

function runCopy(state: ViewerState): ViewerState {
  const node = findNode(state.roots, state.cursorId);
  if (!node) return state;
  const cb = detectClipboard();
  if (!cb) return { ...state, messageBar: "clipboard unavailable" };
  const payload = jsonPayloadFor(node);
  const text = JSON.stringify(payload, null, 2);
  try {
    cb.write(text);
    return { ...state, messageBar: `copied ${text.length} bytes` };
  } catch (e) {
    return { ...state, messageBar: `copy failed: ${(e as Error).message}` };
  }
}

// Re-parse the whole accumulated JSONL after a follow append. We
// preserve the cursor id across reloads; if it has been removed,
// fall back to the first trace root.
function onFollowAppend(
  prev: ViewerState,
  jsonl: string,
  viewport: { rows: number; cols: number },
): ViewerState {
  const parsed = parseStatelogJsonl(jsonl);
  const roots = buildForest(parsed.events);
  if (roots.length === 0) return prev;
  const stillThere = findNode(roots, prev.cursorId);
  const next: ViewerState = {
    ...prev,
    roots,
    cursorId: stillThere ? prev.cursorId : roots[0].id,
  };
  return applyScroll(next, viewport);
}

// Clamp and cursor-follow scrollTop based on the current visible
// rows. Kept in `run.ts` so the pure `handleKey` reducer stays free
// of viewport / rendering concerns.
function applyScroll(
  state: ViewerState,
  viewport: { rows: number; cols: number },
): ViewerState {
  const rows = flattenVisibleRows(state);
  const cursorIdx = rows.findIndex((r) => r.node.id === state.cursorId);
  const visible = treePaneRows(viewport, state);
  const clamped = clampScroll(state.scrollTop, rows.length, visible);
  const scrollTop = cursorIdx >= 0
    ? followCursor(clamped, cursorIdx, visible)
    : clamped;
  return scrollTop === state.scrollTop ? state : { ...state, scrollTop };
}

// Rows available to the tree pane after subtracting (a) the JSON
// pane allotment when open, (b) the bottom status line when present.
function treePaneRows(
  viewport: { rows: number; cols: number },
  state: ViewerState,
): number {
  const reserved = hasStatusBar(state) ? 1 : 0;
  const usable = Math.max(1, viewport.rows - reserved);
  if (!state.jsonPaneOpen) return usable;
  // Tree gets ~60%, pane ~40%, min 1 row each.
  return Math.max(1, Math.floor(usable * 0.6));
}

function jsonPaneRows(
  viewport: { rows: number; cols: number },
  state: ViewerState,
): number {
  const reserved = hasStatusBar(state) ? 1 : 0;
  const usable = Math.max(1, viewport.rows - reserved);
  return Math.max(1, usable - treePaneRows(viewport, state));
}

function hasStatusBar(state: ViewerState): boolean {
  return !!(state.messageBar || (state.matches && state.matches.length > 0) || state.followOn || state.query);
}

function renderState(
  state: ViewerState,
  parseErrors: ReadonlyArray<{ line: number }>,
  viewport: { rows: number; cols: number },
  thresholds: ViewerThresholds,
): Element {
  if (state.helpOpen) return renderHelpOverlay();

  const treeRows = flattenVisibleRows(state);
  const cursorIdx = treeRows.findIndex((r) => r.node.id === state.cursorId);
  const treeHeight = treePaneRows(viewport, state);

  const { element: tree } = scrollList<VisibleRow>({
    items: treeRows,
    cursorIdx,
    scrollTop: state.scrollTop,
    viewportRows: treeHeight,
    renderItem: (vrow, isCursor) => {
      const fg = state.pane === "json" ? "gray" : colorFor(vrow.node);
      return line(
        renderRowText(vrow, isCursor, state.expanded.has(vrow.node.id), {
          query: state.query,
          thresholds,
        }),
        fg ? { fg } : undefined,
      );
    },
  });

  const parts: Element[] = [tree];

  if (state.jsonPaneOpen && state.jsonPane) {
    parts.push(renderJsonPane(state, jsonPaneRows(viewport, state)));
  }

  if (hasStatusBar(state)) {
    parts.push(renderStatusBar(state));
  }

  if (parseErrors.length > 0) {
    parts.push(line(
      `${parseErrors.length} parse error(s) — first: line ${parseErrors[0].line}`,
      { fg: "bright-red" },
    ));
  }

  return column({ justifyContent: "flex-start" }, ...parts);
}

function renderJsonPane(state: ViewerState, height: number): Element {
  const pane = state.jsonPane!;
  const allLines = renderJson(pane.root, {
    open: pane.open,
    cursorPath: pane.cursorPath,
  });
  // The JSON pane needs its own scroll. Compute cursor index for
  // followCursor; we treat the owner-path of the line as the cursor.
  const rowPaths = flattenJsonRows(pane);
  const cursorIdx = rowPaths.indexOf(pane.cursorPath);
  const clamped = clampScroll(pane.scrollTop, allLines.length, height);
  const scrollTop =
    cursorIdx >= 0 ? followCursor(clamped, cursorIdx, height) : clamped;
  const slice = allLines.slice(scrollTop, scrollTop + height);
  const baseFg = state.pane === "json" ? undefined : "gray";
  return column(
    { justifyContent: "flex-start", height },
    ...slice.map((l) => line(segmentsToStyled(l.segments), baseFg ? { fg: baseFg } : undefined)),
  );
}

// Convert per-segment `{text, fg?, bg?}` into a single inline-tagged
// string the TUI's parseStyledText understands. We don't bother
// closing intermediate tags — each segment is fully wrapped.
function segmentsToStyled(
  segments: ReadonlyArray<{ text: string; fg?: string; bg?: string }>,
): string {
  return segments
    .map((s) => {
      let out = s.text;
      if (s.bg) out = `{${s.bg}-bg}${out}{/${s.bg}-bg}`;
      if (s.fg) out = `{${s.fg}-fg}${out}{/${s.fg}-fg}`;
      return out;
    })
    .join("");
}

function renderStatusBar(state: ViewerState): Element {
  const parts: string[] = [];
  if (state.query && state.matches !== undefined) {
    const total = state.matches.length;
    const idx = (state.matchIdx ?? 0) + 1;
    parts.push(total > 0 ? `match ${idx}/${total} — "${state.query}"` : `no matches — "${state.query}"`);
  }
  if (state.followOn) parts.push("[FOLLOW]");
  if (state.messageBar) parts.push(state.messageBar);
  return line(parts.join("  "), { fg: "gray" });
}

function renderHelpOverlay(): Element {
  const out = ["Keybindings", "─────────────", ...helpLines()];
  return lines(out);
}
