// The viewer shell: owns the screen, the view stack, action dispatch, the
// help overlay, the parse-error notice, quit, and follow mode. Everything
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
import { DetailScreen } from "./views/detailScreen.js";
import { TimelineScreen } from "./screens/timelineScreen.js";
import { OverviewScreen } from "./screens/overviewScreen.js";
import { TraceScreen } from "./screens/traceScreen.js";
import { TranscriptScreen } from "./screens/transcriptScreen.js";
import { TracePicker } from "./screens/tracePicker.js";
import { MIN_COLS, tabStrip, tooNarrow } from "./screens/chrome.js";
import type { ScreenName } from "./screens/screen.js";
import { ScreenHost } from "./screenHost.js";
import { escOutcome, type EscOutcome } from "./escLadder.js";
import { cursorBindings, findBinding, helpFrom, hintsFrom, type ViewerBinding } from "./keymap.js";
import { OccurrencesView } from "./views/occurrencesView.js";
import { type ViewAction, type Viewport } from "./views/view.js";
import type { EventEnvelope, TreeNode } from "./types.js";
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
  thresholds?: Partial<ViewerThresholds>;
  // Enables the trace `x` action: extract the focused trace to a file of its
  // own, read back from this local path. Undefined for remote or stdin sources.
  extract?: { sourcePath: string };
  // A run directory's annotations, one summary line per trace id, shown on
  // the trace picker and shell header.
  traceAnnotations?: Record<string, string>;
  // Start with the cursor on this trace (the explorer drilling into a test).
  focusTraceId?: string;
  contextWindowOf?: (model: string) => number | undefined;
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

const HELP_LAYOUT = { fixedRows: 4 };
function helpScreen(helpLines: readonly string[], viewport: Viewport, top: number): Element {
  const page = Math.max(1, viewport.rows - HELP_LAYOUT.fixedRows);
  return lines([
    "Keybindings",
    "─────────────",
    ...helpLines.slice(top, top + page),
    "",
    "j/k or paging to scroll; another key closes help.",
  ]);
}

function makeHelp(helpLines: () => string[], viewport: Viewport, close: () => void) {
  let top = 0;
  const page = Math.max(1, viewport.rows - HELP_LAYOUT.fixedRows);
  const move = (delta: number): void => {
    top = Math.max(0, Math.min(top + delta, Math.max(0, helpLines().length - page)));
  };
  const bindings = cursorBindings({
    by: move,
    toTop: () => move(-Infinity),
    toBottom: () => move(Infinity),
    page: () => page,
    halfPage: () => Math.max(1, Math.floor(page / 2)),
  });
  return {
    render: (): Element => helpScreen(helpLines(), viewport, top),
    reset: (): void => {
      top = 0;
    },
    handleKey: (key: string): void => {
      const binding = findBinding(bindings, key);
      if (binding) {
        binding.run();
      } else {
        close();
        top = 0;
      }
    },
  };
}

function parseErrorNotice(parseErrors: ReadonlyArray<{ line: number }>): Element {
  return line(`${parseErrors.length} parse error(s) — first: line ${parseErrors[0].line}`, {
    fg: "bright-red",
  });
}

export async function runViewer(opts: RunViewerOpts): Promise<ViewerResolution> {
  const watcher = makeFollowWatcher(opts);
  const parsed = parseStatelogJsonl(watcher.bootText);
  const roots = buildForest(parsed.events);
  const parseErrors: ReadonlyArray<{ line: number }> = parsed.errors;
  const allEvents: readonly EventEnvelope[] = parsed.events; // `Y` copies these verbatim

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

  return runSession(opts, screen, watcher, roots, parseErrors, allEvents);
}

type ParseErrors = ReadonlyArray<{ line: number }>;
type ActionHandlers = {
  [Kind in ViewAction["kind"]]: (
    action: Extract<ViewAction, { kind: Kind }>,
  ) => Promise<void> | void;
};

async function runSession(
  opts: RunViewerOpts,
  screen: Screen,
  watcher: FollowWatcher,
  roots: TreeNode[],
  parseErrors: ParseErrors,
  allEvents: readonly EventEnvelope[],
): Promise<ViewerResolution> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const viewport: Viewport = opts.viewport;
  const tooNarrowNow = viewport.cols < MIN_COLS;
  const annotations = opts.traceAnnotations ?? {};
  const bootTraceId = opts.focusTraceId ?? mostRecentTraceId(roots);

  const host = createHost(roots, opts, thresholds, bootTraceId);
  const notify = (message: string): void => host.target().notify(message);

  let followOn = false;
  const innerViewport = (): Viewport => ({
    cols: viewport.cols,
    rows: Math.max(1, viewport.rows - 1 - (parseErrors.length > 0 ? 1 : 0)),
  });
  const onNewText = (text: string): void => {
    const reparsed = parseStatelogJsonl(text);
    roots = buildForest(reparsed.events);
    parseErrors = reparsed.errors;
    allEvents = reparsed.events;
    host.setData(roots, mostRecentTraceId(roots));
    render();
  };
  const toggleFollow = (): void => {
    if (opts.followPath === undefined) {
      notify("follow unavailable when reading from stdin");
      return;
    }
    followOn = !followOn;
    host.setFollowIndicator(followOn);
    if (followOn) {
      watcher.start(onNewText);
    } else {
      watcher.stop();
    }
    notify(followOn ? "follow on" : "follow off");
  };
  const openPicker = (): void => {
    host.openOverlay(
      new TracePicker(roots, {
        currentTraceId: host.currentTraceId(),
        annotations,
        thresholds,
      }),
    );
  };
  const shellBindings = (controls?: ShellControls): ShellBinding[] =>
    viewerShellBindings(host, () => roots, toggleFollow, openPicker, controls);

  const extractIfLocal = async (traceId: string): Promise<void> => {
    if (opts.extract === undefined) {
      return;
    }
    await handleTraceExtract({
      screen,
      sourcePath: opts.extract.sourcePath,
      traceId,
      following: followOn,
      watcher,
      onNewText,
      render,
      notify,
    });
  };
  const onAction: ActionHandlers = {
    none: () => {},
    back: () => host.closeOverlay(),
    openScreen: (action) => host.switchTo(action.screen, action.focusId),
    selectTrace: (action) => host.selectTrace(action.traceId, action.query),
    openDetail: (action) => host.openOverlay(new DetailScreen(roots, action.rowId, thresholds)),
    openOccurrences: (action) =>
      host.openOverlay(
        new OccurrencesView(roots, host.currentTraceId(), action.groupKey, thresholds),
      ),
    promptLine: async (action) => action.onResult(await screen.nextLine(action.label)),
    copy: (action) => copyToClipboard(action.text, notify),
    copyTrace: (action) => copyTraceToClipboard(allEvents, action.traceId, notify),
    extractTrace: (action) => extractIfLocal(action.traceId),
  };

  const dispatch = async (action: ViewAction): Promise<void> => {
    const handler = onAction[action.kind] as (action: ViewAction) => Promise<void> | void;
    await handler(action);
  };
  const help = makeHelp(
    () => [...helpFrom(shellBindings()), ...host.target().helpLines()],
    viewport,
    () => host.closeHelp(),
  );
  const render = (): void => {
    if (tooNarrowNow) {
      screen.render(tooNarrow(viewport.cols));
      return;
    }
    if (host.helpOpen()) {
      screen.render(help.render());
      return;
    }
    help.reset();
    const parts: Element[] = [
      viewerHeader(host, roots, annotations, followOn, viewport.cols),
      ...(parseErrors.length > 0 ? [parseErrorNotice(parseErrors)] : []),
      host
        .target()
        .render(
          innerViewport(),
          hintsFrom(
            shellBindings({ ...HELP_CONTROLS, typing: host.target().capturesText?.() === true }),
          ),
        ),
    ];
    screen.render(column({ justifyContent: "flex-start" }, ...parts));
  };

  if (opts.initialFollow && opts.followPath !== undefined) {
    followOn = true;
    host.setFollowIndicator(true);
    watcher.start(onNewText);
  }
  render();
  try {
    return await runKeyLoop({
      screen,
      host,
      tooNarrowNow,
      embedded: opts.embedded === true,
      innerViewport,
      shellBindings,
      openPicker,
      tracePickerAvailable: () => roots.length > 1,
      handleHelpKey: help.handleKey,
      dispatch,
      render,
    });
  } finally {
    watcher.stop();
  }
}
function createHost(
  roots: TreeNode[],
  opts: RunViewerOpts,
  thresholds: ViewerThresholds,
  bootTraceId: string,
): ScreenHost {
  const annotations = opts.traceAnnotations ?? {};
  const host = new ScreenHost(
    {
      overview: new OverviewScreen(roots, bootTraceId, opts.contextWindowOf ?? (() => undefined)),
      trace: new TraceScreen(roots, bootTraceId, thresholds, {
        extractEnabled: opts.extract !== undefined,
      }),
      transcript: new TranscriptScreen(roots, bootTraceId),
      timeline: new TimelineScreen(roots, bootTraceId, thresholds),
    },
    "overview",
    bootTraceId,
  );
  if (opts.focusTraceId === undefined && roots.length > 1) {
    host.openOverlay(
      new TracePicker(roots, { currentTraceId: bootTraceId, annotations, thresholds }),
    );
  }
  return host;
}

type KeyLoopArgs = {
  screen: Screen;
  host: ScreenHost;
  tooNarrowNow: boolean;
  embedded: boolean;
  innerViewport: () => Viewport;
  shellBindings: (controls?: ShellControls) => ShellBinding[];
  openPicker: () => void;
  tracePickerAvailable: () => boolean;
  handleHelpKey: (key: string) => void;
  dispatch: (action: ViewAction) => Promise<void>;
  render: () => void;
};
async function runKeyLoop(args: KeyLoopArgs): Promise<ViewerResolution> {
  const { screen, host, tooNarrowNow, embedded, innerViewport, shellBindings, dispatch, render } =
    args;
  const onEsc: Record<EscOutcome, () => void> = {
    closeHelp: () => host.closeHelp(),
    overlay: () => {},
    popOverlay: () => host.closeOverlay(),
    screen: () => {},
    goOverview: () => host.switchTo("overview"),
    goTraces: args.openPicker,
    back: () => {},
    nothing: () => {},
  };
  for (;;) {
    const event = await screen.nextKey();
    const key = formatKey(event);
    const typing = host.target().capturesText?.() === true;

    let resolution: ViewerResolution | undefined;
    const binding = findBinding(
      shellBindings({
        typing,
        quit: () => {
          resolution = "quit";
        },
        escape: () => {
          const outcome = escOutcome({
            tooNarrow: tooNarrowNow,
            helpOpen: host.helpOpen(),
            overlayOpen: host.overlayOpen(),
            overlayEscaped: () => host.escapeOverlay(),
            screenEscaped: () => host.escapeScreen(),
            activeScreen: host.activeScreen(),
            tracePickerOpen: host.target() instanceof TracePicker,
            tracePickerAvailable: args.tracePickerAvailable(),
            embedded,
          });
          if (outcome === "back") {
            resolution = "back";
          }
          onEsc[outcome]();
        },
      }),
      key,
    ) as ShellBinding | undefined;
    if (binding?.control) {
      binding.run();
      if (resolution !== undefined) {
        return resolution;
      }
    } else if (tooNarrowNow) {
      continue;
    } else if (host.helpOpen()) {
      args.handleHelpKey(key);
    } else if (typing) {
      await dispatch(host.target().handleKey(event, innerViewport()));
    } else {
      if (binding !== undefined) {
        binding.run();
      } else {
        await dispatch(host.target().handleKey(event, innerViewport()));
      }
    }
    render();
  }
}

/** The trace that started last; the last root when none has a start time. */
export function mostRecentTraceId(roots: TreeNode[]): string {
  const started = roots.filter((root) => root.firstTs !== undefined);
  const latest = [...started].sort((first, second) => second.firstTs! - first.firstTs!)[0];
  return (latest ?? roots.at(-1))?.traceId ?? "";
}

function viewerHeader(
  host: ScreenHost,
  roots: TreeNode[],
  annotations: Record<string, string>,
  following: boolean,
  cols: number,
): Element {
  const target = host.target();
  const picking = target instanceof TracePicker;
  const traceId = picking ? target.selectedTraceId() : host.currentTraceId();
  return tabStrip({
    active: picking ? undefined : host.activeScreen(),
    title: traceId?.slice(0, 8) ?? "",
    tracePosition:
      traceId === undefined
        ? undefined
        : {
            at: roots.findIndex((root) => root.traceId === traceId) + 1,
            of: roots.length,
          },
    annotation:
      traceId !== undefined && Object.hasOwn(annotations, traceId)
        ? annotations[traceId]
        : undefined,
    following,
    cols,
  });
}

function openNumberedScreen(host: ScreenHost, name: ScreenName): void {
  const target = host.target();
  if (target instanceof TracePicker) {
    const traceId = target.selectedTraceId();
    if (traceId === undefined) {
      return;
    }
    if (traceId === host.currentTraceId()) {
      host.closeOverlay();
    } else {
      host.selectTrace(traceId);
    }
  }
  host.switchTo(name);
}

type ShellControls = { typing: boolean; quit: () => void; escape: () => void };
type ShellBinding = ViewerBinding & { control?: boolean };
const HELP_CONTROLS: ShellControls = { typing: false, quit: () => {}, escape: () => {} };
/** Control bindings also run over help and narrow-terminal messages. */
export function viewerShellBindings(
  host: ScreenHost,
  roots: () => TreeNode[],
  toggleFollow: () => void,
  openPicker: () => void,
  controls: ShellControls = HELP_CONTROLS,
): ShellBinding[] {
  const onScreen = (): boolean => !host.overlayOpen();
  const canChooseScreen = (): boolean => onScreen() || host.target() instanceof TracePicker;
  const several = (): boolean => onScreen() && roots().length > 1;
  return [
    {
      keys: ["Escape"],
      help: "back out one step",
      hint: "esc back",
      control: true,
      run: controls.escape,
    },
    {
      keys: ["q"],
      help: "quit",
      hint: "q quit",
      control: true,
      when: () => !controls.typing,
      run: controls.quit,
    },
    {
      keys: ["Ctrl+C"],
      help: "quit",
      hint: controls.typing ? "ctrl+c quit" : undefined,
      control: true,
      run: controls.quit,
    },
    {
      keys: ["?"],
      help: "this help",
      hint: "? help",
      when: () => !controls.typing,
      run: () => host.toggleHelp(),
    },
    {
      keys: ["f"],
      help: "follow the file as it grows",
      hint: "f follow",
      when: () => !controls.typing,
      run: toggleFollow,
    },
    {
      keys: ["1"],
      help: "overview",
      when: canChooseScreen,
      run: () => openNumberedScreen(host, "overview"),
    },
    {
      keys: ["2"],
      help: "trace",
      when: canChooseScreen,
      run: () => openNumberedScreen(host, "trace"),
    },
    {
      keys: ["3"],
      help: "transcript",
      when: canChooseScreen,
      run: () => openNumberedScreen(host, "transcript"),
    },
    {
      keys: ["4"],
      help: "timeline",
      when: canChooseScreen,
      run: () => openNumberedScreen(host, "timeline"),
    },
    {
      keys: ["t"],
      help: "pick a trace or search their text",
      hint: "t traces",
      when: several,
      run: openPicker,
    },
    {
      keys: ["<"],
      help: "previous trace",
      when: several,
      run: () =>
        host.stepTrace(
          -1,
          roots().map((root) => root.traceId),
        ),
    },
    {
      keys: [">"],
      help: "next trace",
      when: several,
      run: () =>
        host.stepTrace(
          1,
          roots().map((root) => root.traceId),
        ),
    },
  ];
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

/** `Y` in the trace screen: every event of one trace, one JSON object per line. */
function copyTraceToClipboard(
  events: readonly EventEnvelope[],
  traceId: string,
  notify: (message: string) => void,
): void {
  const lines = events
    .filter((event) => event.trace_id === traceId)
    .map((event) => JSON.stringify(event));
  copyToClipboard(
    lines.join("\n") + "\n",
    notify,
    `copied ${lines.length} events of trace ${traceId}`,
  );
}

function copyToClipboard(
  text: string,
  notify: (message: string) => void,
  successMessage: string = "copied",
): void {
  const clipboard = detectClipboard();
  if (clipboard === null) {
    notify("clipboard unavailable");
    return;
  }
  try {
    clipboard.write(text);
    notify(successMessage);
  } catch (err) {
    notify(`copy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type { TreeNode };
