// `agency logs` — point it at anything log-shaped. A sole statelog file
// (or "-") opens the interactive viewer; a sole run directory opens the
// viewer on its statelog with each trace's annotations summarised on its
// row; a directory of run directories or several paths open the
// cross-run explorer; --csv prints the table to stdout instead of
// opening a TUI. Routing is decided by discoverSources; this file only
// wires the routes to the two apps.
import * as fs from "fs";
import * as tty from "tty";
import type { AgencyConfig } from "@/config.js";
import { runViewer } from "@/logsViewer/run.js";
import { annotationSummaries } from "@/runDirectory/list.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";
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
  config?: AgencyConfig;
};

/** Injectable route targets, so routing is testable without a TTY. */
export type LogsViewDeps = {
  viewFile?: (file: string, opts: LogsViewOpts) => Promise<void>;
  viewRunDirectory?: (dir: string, opts: LogsViewOpts) => Promise<void>;
  explorer?: (options: { sources: Source[] }) => Promise<void>;
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
  const explorer = deps.explorer ?? runExplorerOnTerminal;
  await explorer({ sources: discovery.sources });
}

function isRegularFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function exitWithError(message: string): void {
  console.error(message);
  process.exit(1);
}

async function runExplorerOnTerminal(options: { sources: Source[] }): Promise<void> {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  try {
    await runExplorer({
      sources: options.sources,
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

/** What the one viewer host runs: in-memory text (with the input-source choice)
 *  or a local file with follow. */
type ViewerSource =
  | { kind: "text"; jsonl: string; terminalInput: ViewerTerminalInput }
  | {
      kind: "file";
      followPath: string;
      initialFollow: boolean;
      /** Set when the file is a run directory's statelog: one summary line
       *  of annotations per trace id, shown on the trace rows. */
      traceAnnotations?: Record<string, string>;
    };

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
): (source: ViewerSource) => Promise<void> {
  return async function runViewerOnTerminal(source: ViewerSource): Promise<void> {
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
    try {
      // Only the drained-stdin case reopens the controlling TTY for keys.
      if (source.kind === "text" && source.terminalInput === "controlling-tty") {
        restoreStdin = dependencies.swapStdinToTty();
      }
      input = dependencies.createInput();
      output = dependencies.createOutput();
      await dependencies.runViewer(viewerOptions(source, input, output, dependencies.viewport()));
    } catch (error) {
      operation = { ok: false, error };
    } finally {
      process.removeListener("SIGINT", sigint);
      process.removeListener("SIGTERM", sigterm);
      throwCombinedLifecycleErrors(operation, releaseOnce());
    }
  };
}

function viewerOptions(
  source: ViewerSource,
  input: InputSource,
  output: OutputTarget,
  viewport: { rows: number; cols: number },
): Parameters<typeof runViewer>[0] {
  if (source.kind === "text") {
    return { jsonl: source.jsonl, input, output, viewport };
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

/** Open the interactive statelog viewer on already-in-memory JSONL. `remote logs`
 *  passes `current-stdin` (stdin is intact after an HTTP fetch); the piped local
 *  `view -` passes `controlling-tty` (stdin was drained for the data). */
export function openViewer(opts: {
  jsonl: string;
  terminalInput: ViewerTerminalInput;
}): Promise<void> {
  return defaultViewerHost({ kind: "text", jsonl: opts.jsonl, terminalInput: opts.terminalInput });
}

/** The original single-file viewer path. A LOCAL file additionally enables the
 *  tree `x` extract-a-trace action; stdin does not (no local file to read). */
async function viewStatelogFile(file: string, cliOpts: LogsViewOpts): Promise<void> {
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const jsonl = Buffer.concat(chunks).toString("utf8");
    if (cliOpts.follow) {
      console.error("--follow ignored when reading from stdin");
    }
    // Piped stdin was drained for the data, so keys come from the controlling TTY.
    // No extract: stdin has no local file to read a trace back from.
    await defaultViewerHost({ kind: "text", jsonl, terminalInput: "controlling-tty" });
    return;
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  await defaultViewerHost({
    kind: "file",
    followPath: file,
    initialFollow: cliOpts.follow ?? false,
  });
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
  await defaultViewerHost({
    kind: "file",
    followPath: runDirPaths(dir).statelog,
    initialFollow: cliOpts.follow === true,
    traceAnnotations: annotationSummaries(snapshot),
  });
}
