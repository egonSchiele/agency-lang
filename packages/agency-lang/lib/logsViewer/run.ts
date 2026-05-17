import { Screen } from "../tui/screen.js";
import { column, text } from "../tui/builders.js";
import type { InputSource, KeyEvent } from "../tui/input/types.js";
import type { OutputTarget } from "../tui/output/types.js";
import { parseStatelogJsonl } from "./parse.js";
import { buildForest } from "./tree.js";
import { renderViewerLines, flattenVisibleRows } from "./render.js";
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
    screen.render(column({}, text("No events found.")));
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
    state = ensureCursorVisible(state, opts.viewport);
    const lines = renderViewerLines(state, opts.viewport);
    if (parsed.errors.length > 0) {
      lines.push("");
      lines.push(
        `${parsed.errors.length} parse error(s) — first: line ${parsed.errors[0].line}`,
      );
    }
    const elements = lines.map((line) => text(line));
    screen.render(column({}, ...elements));
  };

  draw();
  while (!state.quit) {
    const event = await opts.input.nextKey();
    const key = mapKey(event);
    state = handleKey(state, key);
    draw();
  }
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
