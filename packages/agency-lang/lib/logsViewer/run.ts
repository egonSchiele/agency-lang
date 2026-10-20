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
import type { CommentsStore } from "../runDirectory/commentsStore.js";
import { formatAddress } from "./address.js";
import { findRow } from "./detailTarget.js";
import type { Anchor } from "../runDirectory/comments.js";
import { anchorFor, marksFrom } from "./marks.js";
import type { Focus, NavigateResult, SessionPort } from "./session/port.js";
import { isUnavailable, startSessionServer, type SessionServer } from "./session/server.js";
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
import { matchTraceId } from "../runDirectory/traces.js";

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
  // Where this log's comments live, opened by the CLI with the author at
  // the terminal. Undefined (stdin, remote) disables `c`.
  comments?: CommentsStore;
  // Register with the sessions directory so `agency logs session …` can
  // find this viewer. Undefined (every unit test) opens no socket and
  // writes nothing. Needs `followPath`: a session is about a local file.
  session?: { dir: string };
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
  const bootTraceId =
    opts.focusTraceId === undefined
      ? mostRecentTraceId(roots)
      : (resolveTracePrefix(roots, opts.focusTraceId) ?? opts.focusTraceId);

  const host = createHost(roots, opts, thresholds, bootTraceId);
  const notify = (message: string): void => host.target().notify(message);

  let followOn = false;
  const prompt = makePromptGate(() => render());
  const innerViewport = (): Viewport => ({
    cols: viewport.cols,
    rows: Math.max(1, viewport.rows - 1 - (parseErrors.length > 0 ? 1 : 0)),
  });
  const commentsSource = makeCommentsSource({
    store: opts.comments,
    host,
    currentTrace: () => roots.find((root) => root.traceId === host.currentTraceId()),
    render: () => render(),
    notify,
  });
  const onNewText = (text: string): void => {
    const reparsed = parseStatelogJsonl(text);
    roots = buildForest(reparsed.events);
    parseErrors = reparsed.errors;
    allEvents = reparsed.events;
    host.setData(roots, fallbackTraceId(roots, host.currentTraceId(), opts.focusTraceId));
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
      watcher.start(onNewText, commentsSource.refreshIfChanged);
    } else {
      watcher.stop();
    }
    notify(followOn ? "follow on" : "follow off");
  };
  const { openPicker, dispatch } = makeActions({
    host,
    screen,
    thresholds,
    annotations,
    roots: () => roots,
    allEvents: () => allEvents,
    notify,
    render: () => render(),
    extract:
      opts.extract === undefined
        ? undefined
        : {
            sourcePath: opts.extract.sourcePath,
            following: () => followOn,
            watcher,
            onNewText,
          },
    prompt,
  });
  const shellBindings = (controls?: ShellControls): ShellBinding[] =>
    viewerShellBindings(host, () => roots, toggleFollow, openPicker, controls, commentsSource);

  const help = makeHelp(
    () => [...helpFrom(shellBindings()), ...host.target().helpLines()],
    viewport,
    () => host.closeHelp(),
  );
  const render = (): void => {
    if (prompt.defer()) {
      return;
    }
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
    watcher.start(onNewText, commentsSource.refreshIfChanged);
  }
  let session: SessionServer | undefined;
  try {
    commentsSource.refresh();
    render();
    session = await startSessionIfAsked(
      opts,
      sessionPortFor(host, () => roots, commentsSource, notify, render, openPicker),
    );
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
    await session?.stop();
  }
}

async function startSessionIfAsked(
  opts: RunViewerOpts,
  port: SessionPort,
): Promise<SessionServer | undefined> {
  if (opts.session === undefined || opts.followPath === undefined) {
    return undefined;
  }
  const started = await startSessionServer(port, {
    dir: opts.session.dir,
    logPath: opts.followPath,
    commentsPath: opts.comments?.path,
  });
  if (isUnavailable(started)) {
    port.notify(`no session: ${started.unavailable}`);
    return undefined;
  }
  return started;
}

/** The shell's answers to session requests. Every request redraws, since it
 *  may have moved the cursor or changed the marks. */
function sessionPortFor(
  host: ScreenHost,
  roots: () => TreeNode[],
  comments: CommentsSource,
  notify: (message: string) => void,
  render: () => void,
  openPicker: () => void,
): SessionPort {
  return {
    focus: () => sessionFocus(host),
    navigate: (traceId, rowId) => {
      const result = navigateTo(host, roots(), traceId, rowId);
      render();
      return result;
    },
    reloadComments: comments.refresh,
    pick: () => {
      openPicker();
      render();
    },
    notify: (message) => {
      notify(message);
      render();
    },
  };
}

/**
 * The row the person is on: the row a detail overlay shows, else the active
 * screen's selected row. `A`, `c`, and the session's `get` all use this, so
 * they cannot name different rows. A screen's `focusId` is not it: that
 * names the row focus travels to on another screen (a user turn's round, an
 * interrupt's tool). On the picker there is no row.
 */
function focusedRow(host: ScreenHost): { traceId: string; rowId: string | undefined } {
  const target = host.target();
  if (target instanceof DetailScreen) {
    return { traceId: host.currentTraceId(), rowId: target.rowId };
  }
  if (target instanceof TracePicker) {
    return { traceId: target.selectedTraceId() ?? host.currentTraceId(), rowId: undefined };
  }
  if (host.overlayOpen()) {
    return { traceId: host.currentTraceId(), rowId: undefined };
  }
  const screen = host.screen(host.activeScreen());
  // A screen that answers `selectedRowId` has the last word, including
  // "no row here" (undefined) on a turn header or a system block. Only a
  // screen with no such method falls back to its focus id.
  const rowId = screen.selectedRowId === undefined ? screen.focusId() : screen.selectedRowId();
  return { traceId: host.currentTraceId(), rowId };
}

function sessionFocus(host: ScreenHost): Focus {
  return { ...focusedRow(host), screen: host.activeScreen() };
}

/** The session's `navigate`: switch trace when needed, then put the trace
 *  screen's cursor on the row. A row the screen's settings hide is reported,
 *  not landed near. */
function navigateTo(
  host: ScreenHost,
  roots: TreeNode[],
  traceId: string,
  rowId: string | undefined,
): NavigateResult {
  const trace = roots.find((root) => root.traceId === traceId);
  if (trace === undefined) {
    return "no such trace";
  }
  if (rowId !== undefined && findRow(trace, rowId) === undefined) {
    return "no such row";
  }
  // Every refusal comes before the host changes: a refused navigate must
  // leave the person's trace, overlays, and screen as they were.
  const traceScreen = host.screen("trace");
  if (
    rowId !== undefined &&
    traceScreen instanceof TraceScreen &&
    !traceScreen.shows(rowId, trace)
  ) {
    return "row hidden by filter";
  }
  if (traceId !== host.currentTraceId()) {
    host.selectTrace(traceId);
  }
  host.closeHelp();
  // A trace alone means its first row, also when that trace is already
  // open and the cursor sits further down.
  const first = traceScreen instanceof TraceScreen ? traceScreen.firstRowId() : undefined;
  host.switchTo("trace", rowId ?? first);
  return "ok";
}

/**
 * A line prompt owns the bottom row while it is open; a redraw asked for
 * meanwhile (a follow poll, a comments refresh, a session request) would
 * paint over what the person is typing. `defer` says whether a render must
 * wait, and remembers that one was wanted; `close` draws it.
 */
function makePromptGate(render: () => void): {
  open: () => void;
  close: () => void;
  defer: () => boolean;
} {
  let promptOpen = false;
  let dirty = false;
  return {
    open: () => {
      promptOpen = true;
    },
    close: () => {
      promptOpen = false;
      if (dirty) {
        dirty = false;
        render();
      }
    },
    defer: () => {
      if (promptOpen) {
        dirty = true;
        return true;
      }
      dirty = false;
      return false;
    },
  };
}

type ActionDeps = {
  host: ScreenHost;
  screen: Screen;
  thresholds: ViewerThresholds;
  annotations: Record<string, string>;
  roots: () => TreeNode[];
  allEvents: () => readonly EventEnvelope[];
  notify: (message: string) => void;
  render: () => void;
  /** Set when the source is a local file the trace `x` action can read. */
  extract?: {
    sourcePath: string;
    following: () => boolean;
    watcher: FollowWatcher;
    onNewText: (text: string) => void;
  };
  /** Told when a line prompt opens and closes, so the shell can defer redraws. */
  prompt: { open: () => void; close: () => void };
};

/** The shell's answers to the actions a view returns, and the picker opener
 *  the `t` key and Esc share. */
function makeActions(deps: ActionDeps): {
  openPicker: () => void;
  dispatch: (action: ViewAction) => Promise<void>;
} {
  const { host, screen, thresholds, notify } = deps;
  const openPicker = (): void => {
    host.openOverlay(
      new TracePicker(deps.roots(), {
        currentTraceId: host.currentTraceId(),
        annotations: deps.annotations,
        thresholds,
      }),
    );
  };
  const extractIfLocal = async (traceId: string): Promise<void> => {
    if (deps.extract === undefined) {
      return;
    }
    await handleTraceExtract({
      screen,
      sourcePath: deps.extract.sourcePath,
      traceId,
      following: deps.extract.following(),
      watcher: deps.extract.watcher,
      onNewText: deps.extract.onNewText,
      render: deps.render,
      notify,
    });
  };
  const onAction: ActionHandlers = {
    none: () => {},
    back: () => host.closeOverlay(),
    openScreen: (action) => host.switchTo(action.screen, action.focusId),
    selectTrace: (action) => host.selectTrace(action.traceId, action.query),
    openDetail: (action) =>
      host.openOverlay(new DetailScreen(deps.roots(), action.rowId, thresholds)),
    openOccurrences: (action) =>
      host.openOverlay(
        new OccurrencesView(deps.roots(), host.currentTraceId(), action.groupKey, thresholds),
      ),
    promptLine: async (action) => {
      deps.prompt.open();
      let text: string;
      try {
        text = await screen.nextLine(action.label);
      } finally {
        deps.prompt.close();
      }
      action.onResult(text);
    },
    copy: (action) => copyToClipboard(action.text, notify),
    copyTrace: (action) => copyTraceToClipboard(deps.allEvents(), action.traceId, notify),
    extractTrace: (action) => extractIfLocal(action.traceId),
  };
  const dispatch = async (action: ViewAction): Promise<void> => {
    const handler = onAction[action.kind] as (action: ViewAction) => Promise<void> | void;
    await handler(action);
  };
  return { openPicker, dispatch };
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
        // A shell binding may answer with an action, as a screen's does
        // (`A` copies, `c` opens the comment prompt).
        const action = binding.run();
        if (action !== undefined) {
          await dispatch(action);
        }
      } else {
        await dispatch(host.target().handleKey(event, innerViewport()));
      }
    }
    render();
  }
}

/**
 * Where the cursor goes when its trace is not in a fresh forest. A trace asked
 * for by id under `--follow` may not have started yet: while the viewer is
 * still on it, keep waiting for it rather than jumping to the newest trace on
 * the first poll. Once the person moves to another trace, the usual rule
 * applies.
 */
export function fallbackTraceId(
  roots: TreeNode[],
  currentTraceId: string,
  focusTraceId: string | undefined,
): string {
  if (focusTraceId !== undefined && currentTraceId === focusTraceId) {
    // The id may be a prefix: `--trace-id 7f3a` for a trace the viewer
    // could not resolve before it started. Resolve it once it can.
    return resolveTracePrefix(roots, focusTraceId) ?? focusTraceId;
  }
  return mostRecentTraceId(roots);
}

/** The one trace a full id or unique prefix names; undefined when none or
 *  several match. The same rule the CLI applies (`matchTraceId`). */
export function resolveTracePrefix(roots: TreeNode[], idOrPrefix: string): string | undefined {
  const match = matchTraceId(
    roots.map((root) => root.traceId),
    idOrPrefix,
  );
  return match.kind === "one" ? match.id : undefined;
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
  comments: CommentsSource = NO_COMMENTS,
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
    ...rowBindings(host, controls, comments),
  ];
}

/** The keys that act on one row: comment on it, show the agent's notes, copy
 *  its address. A comment goes on a screen's focused row, or on the row a
 *  detail overlay shows, which is the obvious place to leave one. */
function rowBindings(
  host: ScreenHost,
  controls: ShellControls,
  comments: CommentsSource,
): ShellBinding[] {
  const rowNow = (): string | undefined => focusedRow(host).rowId;
  return [
    {
      keys: ["c"],
      help: "comment on the focused row",
      hint: comments.available ? "c comment" : undefined,
      when: () => !controls.typing && rowNow() !== undefined,
      run: () => {
        if (!comments.available) {
          host.target().notify("comments unavailable for this log");
          return;
        }
        // Captured whole before the prompt opens: a session `navigate`
        // can switch traces while the person types.
        const target = comments.targetFor(focusedRow(host));
        if (target === undefined) {
          return;
        }
        return {
          kind: "promptLine",
          label: "comment: ",
          onResult: (text) => {
            if (text.trim().length > 0) {
              comments.add(target, text.trim());
            }
          },
        };
      },
    },
    {
      keys: ["C"],
      help: "show or hide the agent's own notes (replies to your comments always show)",
      when: () => !controls.typing && comments.available,
      run: () => comments.toggleAgentNotes(),
    },
    {
      keys: ["A"],
      help: "copy the focused row's address (<trace id>/<row id>)",
      when: () => !controls.typing,
      run: () => {
        const { traceId, rowId } = focusedRow(host);
        if (rowId === undefined) {
          host.target().notify("no address here");
          return;
        }
        return { kind: "copy", text: formatAddress(traceId, rowId) };
      },
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
  /** `onTick` runs on every poll, grown or not: the comments file can change
   *  while the log is idle. */
  start(onText: (accum: string) => void, onTick?: () => void): void;
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
  let onTick: () => void = () => {};
  const poll = (): void => {
    if (reader === undefined || opts.followPath === undefined) return;
    onTick();
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
    start: (callback, tick) => {
      onText = callback;
      // A restart that names no tick (the extract prompt's) keeps the one
      // it had, so comments keep appearing while follow stays on.
      onTick = tick ?? onTick;
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

/**
 * The one piece of the viewer that reads or writes comments. `refresh` folds
 * the store into marks and hands them to every view; `add` writes and then
 * refreshes. The `c` key, the follow tick, and the session's `reload` all
 * come through here, so the sequence exists once.
 */
export type CommentsSource = {
  available: boolean;
  refresh(): void;
  /** For a poller: re-read only when the file's size changed. */
  refreshIfChanged(): void;
  /** Everything a comment needs, taken while the row is still the one the
   *  person is on. Undefined with no row. */
  targetFor(focus: { traceId: string; rowId: string | undefined }): CommentTarget | undefined;
  add(target: CommentTarget, text: string): void;
  toggleAgentNotes(): void;
};

export type CommentTarget = { traceId: string; rowId: string; anchor: Anchor };

const NO_COMMENTS: CommentsSource = {
  available: false,
  refresh: () => {},
  refreshIfChanged: () => {},
  targetFor: () => undefined,
  add: () => {},
  toggleAgentNotes: () => {},
};

function makeCommentsSource(args: {
  store: CommentsStore | undefined;
  host: ScreenHost;
  currentTrace: () => TreeNode | undefined;
  render: () => void;
  notify: (message: string) => void;
}): CommentsSource {
  const { store } = args;
  if (store === undefined) {
    return NO_COMMENTS;
  }
  let showAgentNotes = false;
  const refresh = (): void => {
    // Runs from the follow tick and from a session request, where a throw
    // would be uncaught and take the viewer down in raw mode.
    try {
      args.host.setMarks(marksFrom(store.read(), { showAgentNotes }));
    } catch (error) {
      args.notify(`comments not read: ${(error as Error).message}`);
    }
    args.render();
  };
  let lastStatError: string | undefined;
  return {
    available: true,
    refresh,
    refreshIfChanged: () => {
      // Runs from the follow timer, where a throw would kill the viewer
      // with the terminal in raw mode; a stat failure is a notice instead,
      // posted once per distinct message rather than on every tick.
      let changed = false;
      try {
        changed = store.changedSince();
        lastStatError = undefined;
      } catch (error) {
        const message = `comments not read: ${(error as Error).message}`;
        if (message !== lastStatError) {
          lastStatError = message;
          args.notify(message);
          args.render();
        }
      }
      if (changed) {
        refresh();
      }
    },
    targetFor: (focus) => {
      if (focus.rowId === undefined) {
        return undefined;
      }
      const trace = args.currentTrace();
      const row = trace === undefined ? undefined : findRow(trace, focus.rowId);
      if (row === undefined) {
        // A row the story does not know (a timeline turn header) would
        // take a comment nothing could find again.
        args.notify("no row to comment on here");
        return undefined;
      }
      return { traceId: focus.traceId, rowId: focus.rowId, anchor: anchorFor(row) };
    },
    add: (target, text) => {
      // Another writer may hold the lock, or the directory may be read-only;
      // the viewer says so and stays up.
      try {
        store.add({ ...target, text });
      } catch (error) {
        args.notify(`comment not saved: ${(error as Error).message}`);
        return;
      }
      refresh();
      args.notify("comment saved");
    },
    toggleAgentNotes: () => {
      showAgentNotes = !showAgentNotes;
      // Said before the refresh, so a read that fails has the last word.
      args.notify(showAgentNotes ? "agent notes shown" : "agent notes hidden");
      refresh();
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
