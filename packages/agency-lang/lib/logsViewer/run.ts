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
import { handleKey } from "./input.js";
import { ViewerState } from "./types.js";

export type RunViewerOpts = {
  jsonl: string;
  input: InputSource;
  output: OutputTarget;
  viewport: { rows: number; cols: number };
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

  const initialState: ViewerState = {
    roots,
    // Default-expand the only trace if there is exactly one.
    expanded: new Set(roots.length === 1 ? [roots[0].id] : []),
    cursorId: roots[0].id,
    scrollTop: 0,
    quit: false,
  };

  await screen.runLoop({
    initialState: applyScroll(initialState, opts.viewport),
    render: (s) => renderState(s, parsed.errors, opts.viewport),
    handleKey: (s, event) => applyScroll(handleKey(s, event), opts.viewport),
    isDone: (s) => s.quit,
  });
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
  const clamped = clampScroll(state.scrollTop, rows.length, viewport.rows);
  const scrollTop = cursorIdx >= 0
    ? followCursor(clamped, cursorIdx, viewport.rows)
    : clamped;
  return scrollTop === state.scrollTop ? state : { ...state, scrollTop };
}

function renderState(
  state: ViewerState,
  parseErrors: ReadonlyArray<{ line: number }>,
  viewport: { rows: number; cols: number },
): Element {
  const rows = flattenVisibleRows(state);
  const cursorIdx = rows.findIndex((r) => r.node.id === state.cursorId);
  const reserved = parseErrors.length > 0 ? 2 : 0; // blank line + error line
  const listViewportRows = Math.max(1, viewport.rows - reserved);

  const { element: list } = scrollList<VisibleRow>({
    items: rows,
    cursorIdx,
    scrollTop: state.scrollTop,
    viewportRows: listViewportRows,
    renderItem: (vrow, isCursor) => {
      const fg = colorFor(vrow.node);
      return line(
        renderRowText(vrow, isCursor, state.expanded.has(vrow.node.id)),
        fg ? { fg } : undefined,
      );
    },
  });

  if (parseErrors.length === 0) return list;
  return column(
    { justifyContent: "flex-start" },
    list,
    line(""),
    line(
      `${parseErrors.length} parse error(s) — first: line ${parseErrors[0].line}`,
      { fg: "bright-red" },
    ),
  );
}
