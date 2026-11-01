// `agency logs` — point it at anything log-shaped. A sole statelog file
// (or "-") opens the interactive viewer; a sole run directory opens the
// viewer on its statelog with each trace's annotations summarised on its
// row; a directory of run directories or several paths open the
// cross-run explorer; --csv prints the table to stdout instead of
// opening a TUI. Routing is decided by discoverSources; this file only
// wires the routes to the two apps.
import * as fs from "fs";
import * as tty from "tty";
import type { AgencyConfig } from "@/config/config.js";
import { _hostedModelInfo } from "@/stdlib/llm.js";
import { runViewer, type ViewerResolution } from "@/logsViewer/run.js";
import type { ViewerThresholds } from "@/logsViewer/thresholds.js";
import { annotationSummaries } from "@/runDirectory/list.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";
import { resolveTraceIdArgument, type Trace } from "@/runDirectory/traces.js";
import { makeLineSplitter } from "@/statelog/lineReader.js";
import { parseStatelogLines, type ParseResult } from "@/statelog/parse.js";
import { commentsPathFor, commentsSourceForStatelog } from "@/runDirectory/commentsPath.js";
import { nodeHost } from "@/host/node/nodeHost.js";
import { sessionsDir } from "@/logsViewer/session/registry.js";
import {
  humanAuthorAtTerminal,
  openCommentsStore,
  type CommentsStore,
} from "@/runDirectory/commentsStore.js";
import { csvRowsFromRuns, exportCsv } from "@/runsExplorer/csv.js";
import { loadAllRuns } from "@/runsExplorer/loader.js";
import { runExplorer } from "@/runsExplorer/run.js";
import { discoverSources, type Source } from "@/runsExplorer/sources.js";
import type { RunRow } from "@/runsExplorer/rows.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import { TerminalOutput } from "@/tui/output/terminal.js";
import type { InputSource } from "@/tui/input/types.js";
import type { OutputTarget } from "@/tui/output/types.js";

export type LogsViewOpts = {
  follow?: boolean;
  csv?: boolean;
  /** Open the viewer on this trace (a full id or unique prefix) instead of
   *  the trace picker. The other traces stay reachable with `t`. */
  traceId?: string;
  config?: AgencyConfig;
};

/** Injectable route targets, so routing is testable without a TTY. */
export type LogsViewDeps = {
  viewFile?: (file: string, opts: LogsViewOpts) => Promise<void>;
  viewRunDirectory?: (dir: string, opts: LogsViewOpts) => Promise<void>;
  explorer?: (options: ExplorerTerminalOptions) => Promise<void>;
  loadAll?: (sources: Source[]) => RunRow[];
  stdout?: (text: string) => void;
  onError?: (message: string) => void;
};

export async function logsView(
  filesArg: string | string[],
  cliOpts: LogsViewOpts = {},
  deps: LogsViewDeps = {},
): Promise<void> {
  const files = Array.isArray(filesArg) ? filesArg : [filesArg];
  const viewFile = deps.viewFile ?? viewStatelogFile;
  const onError = deps.onError ?? exitWithError;

  if (cliOpts.follow === true && (files.length !== 1 || cliOpts.csv === true)) {
    onError(
      "--follow needs exactly one statelog file and cannot combine with --csv or directories",
    );
    return;
  }
  if (cliOpts.traceId !== undefined && (files.length !== 1 || cliOpts.csv === true)) {
    onError(TRACE_ID_USAGE);
    return;
  }
  const soleFile = files.length === 1 ? files[0] : undefined;
  if (soleFile === "-") {
    await viewFile("-", cliOpts);
    return;
  }
  // A sole regular file under --follow skips sniffing entirely: it may
  // be an empty log that is about to be written.
  if (soleFile !== undefined && cliOpts.follow === true && isRegularFile(soleFile)) {
    await viewFile(soleFile, cliOpts);
    return;
  }
  if (cliOpts.follow === true) {
    onError(
      "--follow needs exactly one statelog file and cannot combine with --csv or directories",
    );
    return;
  }

  const discovery = discoverSources(files);
  if (discovery.errors.length > 0) {
    onError(discovery.errors.join("\n"));
    return;
  }
  if (cliOpts.csv === true) {
    const rows = (deps.loadAll ?? loadAllRuns)(discovery.sources);
    const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
    stdout(exportCsv(csvRowsFromRuns(rows), new Date()).content);
    return;
  }
  if (discovery.route === "viewer" && discovery.sources[0]?.kind === "statelog") {
    await viewFile(discovery.sources[0].file, cliOpts);
    return;
  }
  if (discovery.route === "runDirectory" && discovery.sources[0]?.kind === "runDir") {
    await (deps.viewRunDirectory ?? viewRunDirectory)(discovery.sources[0].dir, cliOpts);
    return;
  }
  if (cliOpts.traceId !== undefined) {
    onError(TRACE_ID_USAGE);
    return;
  }
  const explorer = deps.explorer ?? runExplorerOnTerminal;
  await explorer({ sources: discovery.sources, thresholds: cliOpts.config?.viewer });
}

const TRACE_ID_USAGE =
  "--trace-id opens the viewer on one trace: it needs exactly one statelog file or run directory and cannot combine with --csv";

/**
 * The full id of the trace `--trace-id` names in a run directory, whose traces
 * are already read, checked before the terminal is set up so a miss prints as
 * plain text instead of flashing the viewer. A unique prefix is accepted, as
 * `agency logs extract` accepts one. Returns `"none"` when the flag was not
 * given; reports and returns `"missing"` when no trace matches, so the caller
 * can stop. For a statelog file the viewer checks the id instead, against the
 * log it reads. Exported for its test.
 */
export type FocusTrace =
  | { kind: "none" }
  | { kind: "trace"; id: string }
  /** Reported through `onError` already; the caller stops. */
  | { kind: "missing" };

export function resolveFocusTrace(
  traces: readonly Trace[],
  idOrPrefix: string | undefined,
  onError: (message: string) => void,
): FocusTrace {
  if (idOrPrefix === undefined) {
    return { kind: "none" };
  }
  const resolved = resolveTraceIdArgument(
    traces.map((trace) => trace.traceId),
    idOrPrefix,
  );
  if (resolved.kind === "one") {
    return { kind: "trace", id: resolved.id };
  }
  onError(resolved.message);
  return { kind: "missing" };
}

/** Under --follow the id is passed as given, a prefix the viewer resolves
 *  once the trace arrives; otherwise it is the resolved focus. */
type FocusChoice = FocusTrace | string | undefined;

function focusIdOf(focus: FocusChoice): string | undefined {
  if (focus === undefined || typeof focus === "string") {
    return focus;
  }
  return focus.kind === "trace" ? focus.id : undefined;
}

function focusIsMissing(focus: FocusChoice): boolean {
  return typeof focus === "object" && focus.kind === "missing";
}

function isRegularFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function exitWithError(message: string): void {
  console.error(message);
  process.exit(1);
}

type ExplorerTerminalOptions = { sources: Source[]; thresholds?: Partial<ViewerThresholds> };

async function runExplorerOnTerminal(options: ExplorerTerminalOptions): Promise<void> {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  try {
    await runExplorer({
      sources: options.sources,
      thresholds: options.thresholds,
      input,
      output,
      viewport: {
        rows: process.stdout.rows ?? 24,
        cols: process.stdout.columns ?? 80,
      },
    });
  } finally {
    input.destroy();
    if (output.destroy) output.destroy();
  }
}

export type ViewerTerminalInput = "current-stdin" | "controlling-tty";

/** What the one viewer host runs: a parsed log held in memory (with the
 *  input-source choice) or a local file with follow. */
type ViewerSource = (
  | { kind: "events"; parsed: ParseResult; terminalInput: ViewerTerminalInput }
  | {
      kind: "file";
      followPath: string;
      initialFollow: boolean;
      /** Set when the file is a run directory's statelog: one summary line
       *  of annotations per trace id, shown on the trace rows. */
      traceAnnotations?: Record<string, string>;
      comments?: CommentsStore;
    }
) & { thresholds?: Partial<ViewerThresholds>; focusTraceId?: string };

type ViewerTerminalDependencies = {
  createInput(): InputSource;
  createOutput(): OutputTarget;
  swapStdinToTty(): () => void;
  runViewer: typeof runViewer;
  viewport(): { rows: number; cols: number };
};

type ViewerLifecycleResult = { ok: true } | { ok: false; error: unknown };

/** @internal Test seam for the viewer's terminal lifecycle; production consumers
 *  use `openViewer` / `logsView`. This is the ONE owner of terminal
 *  construction, the stdin→TTY swap, viewport, `runViewer`, and cleanup, and it
 *  releases every acquired resource exactly once — combining a primary and any
 *  cleanup errors rather than swallowing them. It also owns SIGINT/SIGTERM (the
 *  output is created without its own interrupt handlers), so an external signal
 *  runs the SAME release path — output, input, and stdin restore — before
 *  exiting, rather than the output's teardown alone. */
export function createViewerHost(
  dependencies: ViewerTerminalDependencies,
): (source: ViewerSource) => Promise<ViewerResolution> {
  return async function runViewerOnTerminal(source: ViewerSource): Promise<ViewerResolution> {
    let restoreStdin: (() => void) | undefined;
    let input: InputSource | undefined;
    let output: OutputTarget | undefined;
    let released = false;
    // Release every acquired resource exactly once — whether from a signal or
    // the finally block — so a signal mid-run and the normal path don't double
    // up. Returns any cleanup errors for the finally to combine.
    const releaseOnce = (): unknown[] => {
      if (released) {
        return [];
      }
      released = true;
      return releaseViewerResources(output, input, restoreStdin);
    };
    const onSignal = (exitCode: number) => (): void => {
      releaseOnce();
      process.exit(exitCode);
    };
    const sigint = onSignal(130);
    const sigterm = onSignal(143);
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);

    let operation: ViewerLifecycleResult = { ok: true };
    let resolution: ViewerResolution = "quit";
    try {
      // Only the drained-stdin case reopens the controlling TTY for keys.
      if (source.kind === "events" && source.terminalInput === "controlling-tty") {
        restoreStdin = dependencies.swapStdinToTty();
      }
      input = dependencies.createInput();
      output = dependencies.createOutput();
      resolution = await dependencies.runViewer(
        viewerOptions(source, input, output, dependencies.viewport()),
      );
    } catch (error) {
      operation = { ok: false, error };
    } finally {
      process.removeListener("SIGINT", sigint);
      process.removeListener("SIGTERM", sigterm);
      throwCombinedLifecycleErrors(operation, releaseOnce());
    }
    return resolution;
  };
}

function viewerOptions(
  source: ViewerSource,
  input: InputSource,
  output: OutputTarget,
  viewport: { rows: number; cols: number },
): Parameters<typeof runViewer>[0] {
  const contextWindowOf = (model: string): number | undefined => {
    const info = _hostedModelInfo(model);
    return info !== null && info.contextWindow > 0 ? info.contextWindow : undefined;
  };
  if (source.kind === "events") {
    return {
      parsed: source.parsed,
      input,
      output,
      viewport,
      contextWindowOf,
      thresholds: source.thresholds,
      focusTraceId: source.focusTraceId,
    };
  }
  return {
    input,
    output,
    viewport,
    followPath: source.followPath,
    initialFollow: source.initialFollow,
    // A local file: the tree's `x` can extract a trace from it.
    extract: { sourcePath: source.followPath },
    traceAnnotations: source.traceAnnotations,
    thresholds: source.thresholds,
    focusTraceId: source.focusTraceId,
    comments: source.comments,
    // A local file: register with the sessions directory so `agency logs
    // session …` can find this viewer.
    session: { dir: sessionsDir(nodeHost()) },
    contextWindowOf,
  };
}

function releaseViewerResources(
  output: OutputTarget | undefined,
  input: InputSource | undefined,
  restoreStdin: (() => void) | undefined,
): unknown[] {
  const errors: unknown[] = [];
  const attempt = (release: (() => void) | undefined): void => {
    if (release === undefined) {
      return;
    }
    try {
      release();
    } catch (error) {
      errors.push(error);
    }
  };
  attempt(output?.destroy?.bind(output));
  attempt(input ? input.destroy.bind(input) : undefined);
  attempt(restoreStdin);
  return errors;
}

function throwCombinedLifecycleErrors(
  operation: ViewerLifecycleResult,
  cleanupErrors: unknown[],
): void {
  const all = operation.ok ? cleanupErrors : [operation.error, ...cleanupErrors];
  if (all.length === 0) {
    return;
  }
  if (all.length === 1) {
    throw all[0];
  }
  throw new AggregateError(all, "viewer terminal lifecycle failed");
}

const defaultViewerHost = createViewerHost({
  createInput: () => new TerminalInput(),
  // The host owns SIGINT/SIGTERM so it can route them through the full release
  // path; the output must not install its own interrupt-and-exit handlers.
  createOutput: () => new TerminalOutput({ manageInterruptSignals: false }),
  swapStdinToTty,
  runViewer,
  viewport: () => ({ rows: process.stdout.rows ?? 24, cols: process.stdout.columns ?? 80 }),
});

/** Open the interactive statelog viewer on a log already parsed in memory.
 *  `remote logs` passes `current-stdin` (stdin is intact after an HTTP fetch);
 *  the piped local `view -` passes `controlling-tty` (stdin was drained for the
 *  data). */
export async function openViewer(opts: {
  parsed: ParseResult;
  terminalInput: ViewerTerminalInput;
  thresholds?: Partial<ViewerThresholds>;
}): Promise<void> {
  await defaultViewerHost({ kind: "events", ...opts });
}

/** Parse a statelog as it streams in, one chunk of lines at a time, so its
 *  text is never one string. */
export async function parseStatelogStream(
  stream: AsyncIterable<Buffer | string>,
): Promise<ParseResult> {
  const splitter = makeLineSplitter();
  const log: ParseResult = { events: [], errors: [] };
  let lineCount = 0;
  const addLines = (lines: string[]): void => {
    const parsed = parseStatelogLines(lines, lineCount + 1);
    lineCount += lines.length;
    parsed.lines.forEach((entry) => log.events.push(entry.event));
    parsed.errors.forEach((error) => log.errors.push(error));
  };
  for await (const chunk of stream) {
    addLines(splitter.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
  }
  addLines(splitter.finish());
  return log;
}

/** The original single-file viewer path. A LOCAL file additionally enables the
 *  tree `x` extract-a-trace action; stdin does not (no local file to read). */
async function viewStatelogFile(file: string, cliOpts: LogsViewOpts): Promise<void> {
  // The viewer checks --trace-id against the log it reads. Under --follow the
  // named trace may not have started yet, and the viewer waits for it.
  if (file === "-") {
    const parsed = await parseStatelogStream(process.stdin);
    if (cliOpts.follow) {
      console.error("--follow ignored when reading from stdin");
    }
    // Piped stdin was drained for the data, so keys come from the controlling TTY.
    // No extract: stdin has no local file to read a trace back from.
    const resolution = await defaultViewerHost({
      kind: "events",
      parsed,
      terminalInput: "controlling-tty",
      thresholds: cliOpts.config?.viewer,
      focusTraceId: cliOpts.traceId,
    });
    failOnMissingTrace(resolution);
    return;
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  const resolution = await defaultViewerHost({
    kind: "file",
    followPath: file,
    initialFollow: cliOpts.follow ?? false,
    thresholds: cliOpts.config?.viewer,
    focusTraceId: cliOpts.traceId,
    // A run directory's statelog opened by path (always the case under
    // --follow) keeps its comments in the directory, like every other route.
    comments: openCommentsStore(
      commentsPathFor(commentsSourceForStatelog(file)),
      humanAuthorAtTerminal(),
    ),
  });
  failOnMissingTrace(resolution);
}

/** A `--trace-id` that named no trace exits with code 1 once the viewer has
 *  given the terminal back, so a script can tell it failed. */
function failOnMissingTrace(resolution: ViewerResolution): void {
  if (resolution === "noSuchTrace") {
    process.exitCode = 1;
  }
}

// Open the controlling terminal at /dev/tty and graft it onto
// `process.stdin` so TerminalInput (which reads process.stdin) sees a
// real TTY. Returns a function that restores the previous stdin
// descriptor. Throws a friendly error on platforms without /dev/tty
// (e.g. Windows).
function swapStdinToTty(): () => void {
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r");
  } catch (err) {
    console.error(
      "agency logs view -: cannot read keystrokes from a non-TTY stdin on this platform.\n" +
        "Try `agency logs view <file>` instead.",
    );
    process.exit(1);
  }
  const ttyStream = new tty.ReadStream(fd);
  const original = process.stdin;
  // Reassign process.stdin so TerminalInput.init() picks up the TTY.
  Object.defineProperty(process, "stdin", {
    configurable: true,
    get: () => ttyStream,
  });
  return () => {
    Object.defineProperty(process, "stdin", {
      configurable: true,
      get: () => original,
    });
    try {
      ttyStream.destroy();
    } catch {
      // best-effort cleanup
    }
  };
}

/** A run directory: its statelog in the viewer, with each trace's notes,
 *  scores and labels summarised on the trace's row. */
async function viewRunDirectory(dir: string, cliOpts: LogsViewOpts): Promise<void> {
  const snapshot = readRunDirectory(dir, { reportWarning: (message) => console.warn(message) });
  const focus: FocusChoice =
    cliOpts.follow === true
      ? cliOpts.traceId
      : resolveFocusTrace(snapshot.traces, cliOpts.traceId, exitWithError);
  if (focusIsMissing(focus)) {
    return;
  }
  await defaultViewerHost({
    kind: "file",
    followPath: runDirPaths(dir).statelog,
    initialFollow: cliOpts.follow === true,
    traceAnnotations: annotationSummaries(snapshot),
    thresholds: cliOpts.config?.viewer,
    focusTraceId: focusIdOf(focus),
    comments: openCommentsStore(commentsPathFor({ kind: "runDir", dir }), humanAuthorAtTerminal()),
  });
}
