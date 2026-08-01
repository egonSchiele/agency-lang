// The viewer shell: owns the screen, the view stack, action dispatch, the
// help overlay, the parse-error footer, quit, and follow mode. Everything
// view-specific lives in the View classes (lib/logsViewer/views/); the
// shell only routes keys to the active view and interprets the actions it
// cannot perform itself.
import { Screen } from "../tui/screen.js";
import { column, line, lines } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import { formatKey } from "../tui/input/format.js";
import type { InputSource } from "../tui/input/types.js";
import type { OutputTarget } from "../tui/output/types.js";
import { currentFileSize, makeAppendReader } from "../statelog/appendReader.js";
import { detectClipboard } from "./clipboard.js";
import { parseStatelogJsonl } from "./parse.js";
import { DEFAULT_THRESHOLDS, ViewerThresholds } from "./thresholds.js";
import { buildForest } from "./tree.js";
import { ByNameView } from "./views/byNameView.js";
import { DetailScreen } from "./views/detailScreen.js";
import { FlameView } from "./views/flameView.js";
import { OccurrencesView } from "./views/occurrencesView.js";
import { TreeView } from "./views/treeView.js";
import { makeViewStack, type ViewAction, type Viewport } from "./views/view.js";
import type { TreeNode } from "./types.js";

export type RunViewerOpts = {
  // The statelog text. Optional when `followPath` is given — the shell
  // then reads the file itself through ONE append reader whose first
  // read() IS the boot read, so nothing can land in a gap between a
  // separate boot read and the watcher start (the old design's bug).
  jsonl?: string;
  input: InputSource;
  output: OutputTarget;
  viewport: { rows: number; cols: number };
  // Optional path to enable --follow mode (re-read as the file grows).
  // Undefined disables follow even if the user presses `f` (e.g. when
  // reading from stdin).
  followPath?: string;
  // If true, start the file watcher immediately at boot — equivalent
  // to launching the viewer and then pressing `f`. Ignored when
  // followPath is undefined.
  initialFollow?: boolean;
  // Watcher poll interval; tests inject a small one.
  followIntervalMs?: number;
  thresholds?: ViewerThresholds;
};

export async function runViewer(opts: RunViewerOpts): Promise<void> {
  const watcher = makeFollowWatcher(opts, (text) => onNewText(text));
  const parsed = parseStatelogJsonl(watcher.bootText);
  let roots = buildForest(parsed.events);
  let parseErrors: ReadonlyArray<{ line: number }> = parsed.errors;

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
  const viewport: Viewport = opts.viewport;
  const treeView = new TreeView(roots, thresholds, viewport);
  const stack = makeViewStack(treeView);
  // The trace timeline views open on: fixed when flame opens from the tree.
  let timelineTraceId = treeView.cursorTraceId();
  let helpOpen = false;
  let quit = false;

  let followOn = false;
  const onNewText = (text: string): void => {
    const reparsed = parseStatelogJsonl(text);
    const rebuilt = buildForest(reparsed.events);
    if (rebuilt.length === 0) return;
    roots = rebuilt;
    parseErrors = reparsed.errors;
    for (const view of stack.all()) view.setData(roots);
    render();
  };
  const toggleFollow = (): void => {
    if (!opts.followPath) {
      stack.active().notify("follow unavailable when reading from stdin");
      return;
    }
    followOn = !followOn;
    treeView.setFollowIndicator(followOn);
    if (followOn) watcher.start();
    else watcher.stop();
    stack.active().notify(followOn ? "follow on" : "follow off");
  };

  if (opts.initialFollow && opts.followPath) {
    followOn = true;
    treeView.setFollowIndicator(true);
    watcher.start();
  }

  const render = (): void => {
    if (helpOpen) {
      screen.render(lines(["Keybindings", "─────────────", ...stack.active().helpLines(), "", "Press any key to close."]));
      return;
    }
    const body = stack.active().render(viewport);
    const parts: Element[] = [body];
    if (parseErrors.length > 0) {
      parts.push(line(
        `${parseErrors.length} parse error(s) — first: line ${parseErrors[0].line}`,
        { fg: "bright-red" },
      ));
    }
    screen.render(column({ justifyContent: "flex-start" }, ...parts));
  };

  const dispatch = async (action: ViewAction): Promise<void> => {
    if (action.kind === "open") {
      if (action.view === "tree") {
        stack.popTo("tree");
        return;
      }
      if (stack.popTo(action.view)) return;
      if (action.view === "flame") {
        timelineTraceId = treeView.cursorTraceId();
        stack.push(new FlameView(roots, timelineTraceId, thresholds));
      } else {
        stack.push(new ByNameView(roots, timelineTraceId, thresholds));
      }
    } else if (action.kind === "openFlameAt") {
      stack.push(new FlameView(roots, timelineTraceId, thresholds, { drillTo: action.spanId }));
    } else if (action.kind === "openOccurrences") {
      stack.push(new OccurrencesView(roots, timelineTraceId, action.groupKey, thresholds));
    } else if (action.kind === "openDetail") {
      stack.push(new DetailScreen(roots, action.spanId, thresholds));
    } else if (action.kind === "focusInTree") {
      stack.popTo("tree");
      treeView.reveal(action.spanId);
    } else if (action.kind === "back") {
      if (stack.all().length === 1) return;
      stack.pop();
    } else if (action.kind === "promptLine") {
      const text = await screen.nextLine(action.label);
      action.onResult(text);
    } else if (action.kind === "copy") {
      copyToClipboard(action.text, (message) => stack.active().notify(message));
    }
  };

  render();
  try {
    while (!quit) {
      const event = await screen.nextKey();
      const fmt = formatKey(event);
      if (fmt === "q" || fmt === "Ctrl+C") {
        quit = true;
        break;
      }
      if (helpOpen) {
        helpOpen = false;
        render();
        continue;
      }
      if (fmt === "?") {
        helpOpen = true;
        render();
        continue;
      }
      if (fmt === "f") {
        toggleFollow();
        render();
        continue;
      }
      await dispatch(stack.active().handleKey(event, viewport));
      render();
    }
  } finally {
    watcher.stop();
  }
}

/**
 * The follow watcher. One reader, one offset cursor, alive for the whole
 * session: its first read() IS the boot read, so nothing can land in a
 * gap between a separate boot read and the watcher start, and `f`
 * toggles POLLING only — the reader persists, so there is no accumulator
 * to rewind (the two bugs that made the old follow dead on arrival). A
 * file that SHRANK was rotated/truncated: start over from offset 0 with
 * an empty accumulator; view setData cursor-fallback absorbs it.
 */
function makeFollowWatcher(
  opts: RunViewerOpts,
  onText: (accum: string) => void,
): { bootText: string; start(): void; stop(): void } {
  let reader = opts.followPath !== undefined ? makeAppendReader(opts.followPath, 0) : undefined;
  let lastSize = opts.followPath !== undefined ? currentFileSize(opts.followPath) : 0;
  let accum = reader !== undefined ? reader.read() : (opts.jsonl ?? "");
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const poll = (): void => {
    if (reader === undefined || opts.followPath === undefined) return;
    const size = currentFileSize(opts.followPath);
    if (size < lastSize) {
      reader = makeAppendReader(opts.followPath, 0);
      accum = "";
    }
    lastSize = size;
    const chunk = reader.read();
    if (chunk.length > 0) {
      accum += chunk;
      onText(accum);
    }
  };
  return {
    bootText: accum,
    start: () => {
      if (opts.followPath === undefined || pollTimer !== undefined) return;
      pollTimer = setInterval(poll, opts.followIntervalMs ?? 250);
    },
    stop: () => {
      if (pollTimer === undefined) return;
      clearInterval(pollTimer);
      pollTimer = undefined;
    },
  };
}

function copyToClipboard(text: string, notify: (message: string) => void): void {
  const clipboard = detectClipboard();
  if (clipboard === null) {
    notify("clipboard unavailable");
    return;
  }
  try {
    clipboard.write(text);
    notify("copied");
  } catch (err) {
    notify(`copy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type { TreeNode };
