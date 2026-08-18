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
import { findTrace, writeTraceFile } from "../runDirectory/extractTrace.js";

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
  // Hosted inside another TUI (the runs explorer): Esc at the bottom of
  // the stack RETURNS to the host instead of doing nothing, and the
  // resolution tells the host whether the user backed out or quit.
  embedded?: boolean;
  thresholds?: ViewerThresholds;
  // Enables the tree `x` action: extract the focused trace to a file of its
  // own, read back from this local path. Undefined for remote or stdin sources.
  extract?: { sourcePath: string };
  // A run directory's annotations, one summary line per trace id, shown on
  // each trace's row in the tree.
  traceAnnotations?: Record<string, string>;
  // Start with the cursor on this trace (the explorer drilling into a test).
  focusTraceId?: string;
};

export type ViewerResolution = "quit" | "back";

/** Follow watcher handle, named so the extract handler can pause and resume it. */
type FollowWatcher = ReturnType<typeof makeFollowWatcher>;

/**
 * Extract the focused trace to a file: ask where (default `<traceId>.jsonl` in
 * the working directory), re-read the trace from the source file so the copy
 * is verbatim, and write it. Follow is paused during the prompt so an append
 * cannot repaint over it.
 */
async function handleTraceExtract(args: {
  screen: Screen;
  sourcePath: string;
  traceId: string;
  following: boolean;
  watcher: FollowWatcher;
  onNewText: (text: string) => void;
  render: () => void;
  notify: (message: string) => void;
}): Promise<void> {
  if (args.following) {
    args.watcher.stop();
  }
  try {
    const answer = await args.screen.nextLine(`Write trace to [${args.traceId}.jsonl]: `);
    const outPath = answer.trim().length === 0 ? `${args.traceId}.jsonl` : answer.trim();
    const match = findTrace(args.sourcePath, args.traceId);
    if (match.kind !== "one") {
      args.notify("Cannot extract: that trace is no longer in the file.");
      return;
    }
    writeTraceFile({ trace: match.trace, outPath, sourcePath: args.sourcePath });
    args.notify(`Wrote ${match.trace.lines.length} events to ${outPath}.`);
  } catch (error) {
    args.notify(`Extract failed: ${(error as Error).message}`);
  } finally {
    if (args.following) {
      args.watcher.start(args.onNewText);
    }
    args.render();
  }
}

function helpScreen(helpLines: readonly string[]): Element {
  return lines(["Keybindings", "─────────────", ...helpLines, "", "Press any key to close."]);
}

function parseErrorFooter(parseErrors: ReadonlyArray<{ line: number }>): Element {
  return line(`${parseErrors.length} parse error(s) — first: line ${parseErrors[0].line}`, {
    fg: "bright-red",
  });
}

export async function runViewer(opts: RunViewerOpts): Promise<ViewerResolution> {
  const watcher = makeFollowWatcher(opts);
  const parsed = parseStatelogJsonl(watcher.bootText);
  let roots = buildForest(parsed.events);
  let parseErrors: ReadonlyArray<{ line: number }> = parsed.errors;

  const screen = new Screen({
    input: opts.input,
    output: opts.output,
    width: opts.viewport.cols,
    height: opts.viewport.rows,
  });

  // Empty log: exit — EXCEPT under --follow, where an empty (or not yet
  // created) file is the most useful case: keep polling and render as
  // events arrive.
  if (roots.length === 0 && !(opts.followPath !== undefined && opts.initialFollow)) {
    screen.render(lines(["No events found."]));
    await opts.input.nextKey();
    return "back";
  }

  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const viewport: Viewport = opts.viewport;
  const treeView = new TreeView(roots, thresholds, viewport, {
    extractEnabled: opts.extract !== undefined,
    traceAnnotations: opts.traceAnnotations,
    focusTraceId: opts.focusTraceId,
  });
  const stack = makeViewStack(treeView);
  // The trace timeline views open on: fixed when flame opens from the tree.
  let timelineTraceId = treeView.cursorTraceId();
  let helpOpen = false;
  let quit = false;

  let followOn = false;
  const onNewText = (text: string): void => {
    // Update the parsed state unconditionally — including to an EMPTY forest.
    // A truncation/rotation to empty or malformed content must clear the views;
    // returning early here would leave the previous file's trace selectable, so
    // `x` could extract a trace no longer in the file.
    const reparsed = parseStatelogJsonl(text);
    roots = buildForest(reparsed.events);
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
    for (const view of stack.all()) view.setFollowIndicator(followOn);
    if (followOn) watcher.start(onNewText);
    else watcher.stop();
    stack.active().notify(followOn ? "follow on" : "follow off");
  };

  if (opts.initialFollow && opts.followPath) {
    followOn = true;
    treeView.setFollowIndicator(true);
    watcher.start(onNewText);
  }

  const render = (): void => {
    if (helpOpen) {
      screen.render(helpScreen(stack.active().helpLines()));
      return;
    }
    const parts: Element[] = [stack.active().render(viewport)];
    if (parseErrors.length > 0) parts.push(parseErrorFooter(parseErrors));
    screen.render(column({ justifyContent: "flex-start" }, ...parts));
  };

  const pushView = (view: FlameView | ByNameView | OccurrencesView | DetailScreen): void => {
    view.setFollowIndicator(followOn);
    stack.push(view);
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
        pushView(new FlameView(roots, timelineTraceId, thresholds));
      } else {
        pushView(new ByNameView(roots, timelineTraceId, thresholds));
      }
    } else if (action.kind === "openFlameAt") {
      pushView(new FlameView(roots, timelineTraceId, thresholds, { drillTo: action.spanId }));
    } else if (action.kind === "openOccurrences") {
      pushView(new OccurrencesView(roots, timelineTraceId, action.groupKey, thresholds));
    } else if (action.kind === "openDetail") {
      pushView(new DetailScreen(roots, action.spanId, thresholds));
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
    } else if (action.kind === "extractTrace" && opts.extract !== undefined) {
      await handleTraceExtract({
        screen,
        sourcePath: opts.extract.sourcePath,
        traceId: action.traceId,
        following: followOn,
        watcher,
        onNewText,
        render,
        notify: (message: string) => stack.active().notify(message),
      });
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
      // Esc backs out, never quits: with nothing left to pop or clear,
      // an embedded viewer hands control back to its host.
      if (
        opts.embedded &&
        fmt === "Escape" &&
        stack.all().length === 1 &&
        !treeView.hasActiveSearch()
      ) {
        return "back";
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
  return quit ? "quit" : "back";
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
function makeFollowWatcher(opts: RunViewerOpts): {
  bootText: string;
  start(onText: (accum: string) => void): void;
  stop(): void;
} {
  let reader = opts.followPath !== undefined ? makeAppendReader(opts.followPath, 0) : undefined;
  let lastSize = opts.followPath !== undefined ? currentFileSize(opts.followPath) : 0;
  let accum = reader !== undefined ? reader.read() : (opts.jsonl ?? "");
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  // The callback is bound at start(), never at construction — so the
  // watcher cannot reach into the shell before the shell finishes wiring
  // itself up (a temporal-dead-zone hazard otherwise).
  let onText: (accum: string) => void = () => {};
  const poll = (): void => {
    if (reader === undefined || opts.followPath === undefined) return;
    const size = currentFileSize(opts.followPath);
    const truncated = size < lastSize;
    if (truncated) {
      reader = makeAppendReader(opts.followPath, 0);
      accum = "";
    }
    lastSize = size;
    const chunk = reader.read();
    if (chunk.length > 0) {
      accum += chunk;
      onText(accum);
    } else if (truncated) {
      // A shrink to empty (or whitespace) still changes what is on screen.
      // Notify with the reset accumulator so the views clear rather than keep a
      // trace no longer in the file — a chunk-only trigger would miss this.
      onText(accum);
    }
  };
  return {
    bootText: accum,
    start: (callback) => {
      onText = callback;
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
