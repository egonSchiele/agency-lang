import { Screen } from "../tui/screen.js";
import { column, line, lines } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import type { InputSource } from "../tui/input/types.js";
import type { OutputTarget } from "../tui/output/types.js";
import { clampScroll, followCursor } from "../tui/scroll.js";
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
    initialState,
    render: (s) => renderState(s, parsed.errors, opts.viewport),
    handleKey,
    isDone: (s) => s.quit,
  });
}

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
  const adjusted = applyScroll(state, viewport);
  const visible = flattenVisibleRows(adjusted).slice(
    adjusted.scrollTop,
    adjusted.scrollTop + viewport.rows,
  );
  const rendered = renderViewerLines(adjusted, viewport);
  const elements: Element[] = visible.map((vrow, i) => {
    const fg = colorFor(vrow.node);
    return line(rendered[i], fg ? { fg } : undefined);
  });
  if (parseErrors.length > 0) {
    elements.push(line(""));
    elements.push(
      line(
        `${parseErrors.length} parse error(s) — first: line ${parseErrors[0].line}`,
        { fg: "bright-red" },
      ),
    );
  }
  return column({ justifyContent: "flex-start" }, ...elements);
}
