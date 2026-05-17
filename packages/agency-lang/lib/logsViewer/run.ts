import { Screen } from "../tui/screen.js";
import { column } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import type { InputSource, KeyEvent } from "../tui/input/types.js";
import type { OutputTarget } from "../tui/output/types.js";
import { parseStatelogJsonl } from "./parse.js";
import { buildForest } from "./tree.js";
import {
  renderViewerLines,
  flattenVisibleRows,
  colorFor,
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
    screen.render(
      column(
        { justifyContent: "flex-start" },
        row("No events found."),
      ),
    );
    await opts.input.nextKey();
    return;
  }

  let state: ViewerState = {
    roots,
    // Default-expand the only trace if there is exactly one.
    expanded: new Set(roots.length === 1 ? [roots[0].id] : []),
    cursorId: roots[0].id,
    scrollTop: 0,
    quit: false,
  };

  const draw = () => {
    state = clampScrollTop(state, opts.viewport);
    state = ensureCursorVisible(state, opts.viewport);
    const visible = flattenVisibleRows(state).slice(
      state.scrollTop,
      state.scrollTop + opts.viewport.rows,
    );
    const lines = renderViewerLines(state, opts.viewport);
    const elements: Element[] = visible.map((vrow, i) =>
      row(lines[i], colorFor(vrow.node)),
    );
    if (parsed.errors.length > 0) {
      elements.push(row(""));
      elements.push(
        row(
          `${parsed.errors.length} parse error(s) — first: line ${parsed.errors[0].line}`,
          "bright-red",
        ),
      );
    }
    screen.render(
      column({ justifyContent: "flex-start" }, ...elements),
    );
  };

  draw();
  while (!state.quit) {
    const event = await opts.input.nextKey();
    const key = mapKey(event);
    state = handleKey(state, key);
    draw();
  }
}

// One single-line row. height: 1 stops the default flex: 1 from
// stretching each line to fill the viewport (which is what made the
// viewer look triple-spaced in v1).
function row(content: string, fg?: string): Element {
  return {
    type: "text",
    content,
    style: fg ? { height: 1, fg } : { height: 1 },
  };
}

function clampScrollTop(
  state: ViewerState,
  viewport: { rows: number; cols: number },
): ViewerState {
  const rows = flattenVisibleRows(state);
  const maxTop = Math.max(0, rows.length - viewport.rows);
  if (state.scrollTop <= maxTop && state.scrollTop >= 0) return state;
  return { ...state, scrollTop: Math.max(0, Math.min(state.scrollTop, maxTop)) };
}

function ensureCursorVisible(
  state: ViewerState,
  viewport: { rows: number; cols: number },
): ViewerState {
  const rows = flattenVisibleRows(state);
  const cursorIdx = rows.findIndex((r) => r.node.id === state.cursorId);
  if (cursorIdx < 0) return state;
  if (cursorIdx < state.scrollTop) {
    return { ...state, scrollTop: cursorIdx };
  }
  if (cursorIdx >= state.scrollTop + viewport.rows) {
    return { ...state, scrollTop: cursorIdx - viewport.rows + 1 };
  }
  return state;
}

function mapKey(event: KeyEvent): string {
  if (event.ctrl) {
    if (event.key === "c") return "Ctrl+C";
    if (event.key === "n") return "Ctrl+N";
    if (event.key === "p") return "Ctrl+P";
  }
  switch (event.key) {
    case "up":
      return "Up";
    case "down":
      return "Down";
    case "left":
      return "Left";
    case "right":
      return "Right";
    case "enter":
      return "Enter";
    default:
      return event.key;
  }
}
