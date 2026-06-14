import { Screen } from "../tui/screen.js";
import { column, line, lines } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import type { InputSource } from "../tui/input/types.js";
import type { OutputTarget } from "../tui/output/types.js";
import { clampScroll, followCursor } from "../tui/scroll.js";
import { scrollList } from "../tui/scrollList.js";
import {
  flattenVisibleRows,
  colorFor,
  renderRowText,
  VisibleRow,
} from "./render.js";
import { handleKeyEx } from "./input.js";
import { formatKey } from "../tui/input/format.js";
import type { KeyEvent } from "../tui/input/types.js";
import { TreeNode } from "./treeNode.js";
import type { ParseError } from "../statelogParser.js";
import type { ViewerState } from "./types.js";
import { findMatches, expandAncestorsOf } from "./search.js";
import { detectClipboard } from "./clipboard.js";
import { follow, Follower } from "./follow.js";
import { helpLines } from "./help.js";
import { DEFAULT_THRESHOLDS, ViewerThresholds } from "./thresholds.js";

// Where the viewer reads its tree from: a file path (enables follow) or an
// in-memory JSONL string (stdin pipe; no follow). The parser is created and
// hidden inside TreeNode — the viewer never touches StatelogParser.
export type ViewerSource = { path: string } | { jsonl: string };

export type RunViewerOpts = {
  source: ViewerSource;
  input: InputSource;
  output: OutputTarget;
  viewport: { rows: number; cols: number };
  // If true, start the file watcher immediately at boot — equivalent to
  // launching the viewer and then pressing `f`. Ignored for stdin sources.
  initialFollow?: boolean;
  thresholds?: ViewerThresholds;
};

export async function runViewer(opts: RunViewerOpts): Promise<void> {
  const source = opts.source;
  const followPath = "path" in source ? source.path : undefined;
  // Build (or rebuild, on follow) the forest. The hidden parser re-reads the
  // whole file each time — simpler than incremental and the file is usually
  // tiny. Parse errors are reachable from any root (only rendered when roots
  // exist, matching the "No events found." short-circuit below).
  const buildForest = (): TreeNode[] =>
    "path" in source
      ? TreeNode.forestFromLog(source.path)
      : TreeNode.forestFromString(source.jsonl);

  let roots = buildForest();
  const parseErrors = (): ParseError[] => roots[0]?.parseErrors() ?? [];

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
      // Propagate the terminal width into state so render, input,
      // and search all wrap promptCompletion convoLines to the same
      // boundary.
      viewportCols: opts.viewport.cols,
    },
    opts.viewport,
  );

  // Follow mode book-keeping. The watcher is started/stopped lazily when the
  // user toggles `f`. On each append we rebuild the forest from the grown file.
  let follower: Follower | undefined;
  const startFollow = (): void => {
    if (!followPath || follower) return;
    follower = follow({
      path: followPath,
      onAppend: () => {
        roots = buildForest();
        state = onFollowAppend(state, roots, opts.viewport);
        screen.render(renderState(state, parseErrors(), opts.viewport, thresholds));
      },
    });
  };
  const stopFollow = (): void => {
    if (!follower) return;
    follower.stop();
    follower = undefined;
  };

  // Auto-start follow if --follow was passed. We do this after building state
  // so the [FOLLOW] indicator appears in the first render below.
  if (opts.initialFollow && followPath) {
    startFollow();
    state = { ...state, followOn: true };
  }

  screen.render(renderState(state, parseErrors(), opts.viewport, thresholds));
  try {
    while (!state.quit) {
      const event = await screen.nextKey();
      // Global quit, regardless of any overlay.
      if (
        event.key === "q" ||
        (event.ctrl && (event.key === "c" || event.key === "C"))
      ) {
        state = { ...state, quit: true };
        break;
      }
      // Vim-style page scroll — handled here because page size is
      // viewport-dependent and the pure reducer doesn't know the
      // viewport. We move the cursor by N rows; applyScroll then
      // pages the viewport along with it.
      const paged = paginate(state, event, opts.viewport);
      if (paged) {
        state = applyScroll(paged, opts.viewport);
        screen.render(renderState(state, parseErrors(), opts.viewport, thresholds));
        continue;
      }
      const { state: next, command } = handleKeyEx(state, event);
      state = applyScroll(next, opts.viewport);
      if (command?.kind === "search") {
        const query = await screen.nextLine("Search: ");
        state = applySearch(state, query, opts.viewport);
      } else if (command?.kind === "copy") {
        state = runCopy(state);
      } else if (command?.kind === "toggleFollow") {
        state = runToggleFollow(state, followPath, startFollow, stopFollow);
      }
      state = applyScroll(state, opts.viewport);
      screen.render(renderState(state, parseErrors(), opts.viewport, thresholds));
    }
  } finally {
    stopFollow();
  }
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
  const matches = findMatches(state.roots, trimmed, state.viewportCols);
  if (matches.length === 0) {
    // The status bar already renders `no matches — "query"` from the
    // query/matches state; don't also set a transient messageBar or the two
    // overlap into a garbled duplicate line.
    return {
      ...state,
      query: trimmed,
      matches: [],
      matchIdx: undefined,
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
    // We only end up here when the viewer was launched without a
    // file path (stdin pipe). There is no on-disk file to tail.
    return { ...state, messageBar: "follow unavailable when reading from stdin" };
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
  const payload = node.event() ?? {
    label: node.label,
    traceId: node.traceId,
    metrics: { duration: node.duration, tokens: node.tokens, cost: node.cost },
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    cb.write(text);
    return { ...state, messageBar: `copied ${text.length} bytes` };
  } catch (e) {
    return { ...state, messageBar: `copy failed: ${(e as Error).message}` };
  }
}

// Swap in a freshly-rebuilt forest after a follow append. We preserve the
// cursor id across reloads; if its node has been removed, fall back to the
// first trace root. (Line-derived ids stay stable for existing lines.)
function onFollowAppend(
  prev: ViewerState,
  roots: TreeNode[],
  viewport: { rows: number; cols: number },
): ViewerState {
  if (roots.length === 0) return prev;
  const stillThere = findNode(roots, prev.cursorId);
  const next: ViewerState = {
    ...prev,
    roots,
    cursorId: stillThere ? prev.cursorId : roots[0].id,
  };
  return applyScroll(next, viewport);
}

// Vim-style page scroll. Returns the updated state if `event` is a
// page-scroll key; otherwise undefined so the caller falls through
// to the normal reducer.
function paginate(
  state: ViewerState,
  event: KeyEvent,
  viewport: { rows: number; cols: number },
): ViewerState | undefined {
  const fmt = formatKey(event);
  const pageRows = Math.max(1, treePaneRows(viewport, state) - 1);
  const halfPage = Math.max(1, Math.floor(pageRows / 2));
  let delta = 0;
  if (fmt === "Ctrl+F" || fmt === "PageDown") delta = +pageRows;
  else if (fmt === "Ctrl+B" || fmt === "PageUp") delta = -pageRows;
  else if (fmt === "Ctrl+D") delta = +halfPage;
  else if (fmt === "Ctrl+U") delta = -halfPage;
  else return undefined;
  const rows = flattenVisibleRows(state);
  if (rows.length === 0) return state;
  const curIdx = Math.max(0, rows.findIndex((r) => r.node.id === state.cursorId));
  const nextIdx = Math.min(rows.length - 1, Math.max(0, curIdx + delta));
  return { ...state, cursorId: rows[nextIdx].node.id };
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

// Rows available to the tree after subtracting the bottom status
// line (when present).
function treePaneRows(
  viewport: { rows: number; cols: number },
  state: ViewerState,
): number {
  const reserved = hasStatusBar(state) ? 1 : 0;
  return Math.max(1, viewport.rows - reserved);
}

function hasStatusBar(state: ViewerState): boolean {
  return !!(
    state.messageBar ||
    (state.matches && state.matches.length > 0) ||
    state.followOn ||
    state.query
  );
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
      const fg = colorFor(vrow.node);
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
