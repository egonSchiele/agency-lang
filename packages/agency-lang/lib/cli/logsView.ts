// `agency logs` — point it at anything log-shaped. A sole statelog file
// (or "-") opens the interactive viewer exactly as before; a run
// directory, a directory of run directories, or several paths open the
// cross-run explorer; --csv prints the table to stdout instead of
// opening a TUI. Routing is decided by discoverSources; this file only
// wires the routes to the two apps.
import * as fs from "fs";
import * as tty from "tty";
import { runViewer } from "@/logsViewer/run.js";
import { csvRowsFromRuns, exportCsv } from "@/runsExplorer/csv.js";
import { loadAllRuns } from "@/runsExplorer/loader.js";
import { runExplorer } from "@/runsExplorer/run.js";
import { discoverSources, type Source } from "@/runsExplorer/sources.js";
import type { RunRow } from "@/runsExplorer/rows.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import { TerminalOutput } from "@/tui/output/terminal.js";

export type LogsViewOpts = { follow?: boolean; csv?: boolean };

/** Injectable route targets, so routing is testable without a TTY. */
export type LogsViewDeps = {
  viewFile?: (file: string, opts: { follow?: boolean }) => Promise<void>;
  explorer?: (options: { sources: Source[]; route: "runTable" | "explorer" }) => Promise<void>;
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
    onError("--follow needs exactly one statelog file and cannot combine with --csv or directories");
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
    onError("--follow needs exactly one statelog file and cannot combine with --csv or directories");
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
  const explorer = deps.explorer ?? runExplorerOnTerminal;
  await explorer({
    sources: discovery.sources,
    route: discovery.route === "runTable" ? "runTable" : "explorer",
  });
}

function isRegularFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function exitWithError(message: string): void {
  console.error(message);
  process.exit(1);
}

async function runExplorerOnTerminal(
  options: { sources: Source[]; route: "runTable" | "explorer" },
): Promise<void> {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  try {
    await runExplorer({
      ...options,
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

/** The original single-file viewer path, behavior unchanged. */
async function viewStatelogFile(file: string, cliOpts: { follow?: boolean }): Promise<void> {
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const jsonl = Buffer.concat(chunks).toString("utf8");
    if (cliOpts.follow) {
      console.error("--follow ignored when reading from stdin");
    }
    await runWith(jsonl, { stdinIsPipe: true });
    return;
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  // No pre-read: the viewer reads the file through its own append
  // reader, whose first read() is the boot read — the old separate
  // pre-read left a gap the watcher never covered. `followPath` also
  // lets the user toggle follow at runtime with `f`.
  await runWith(undefined, {
    stdinIsPipe: false,
    followPath: file,
    initialFollow: cliOpts.follow ?? false,
  });
}

async function runWith(
  jsonl: string | undefined,
  opts: { stdinIsPipe: boolean; followPath?: string; initialFollow?: boolean },
): Promise<void> {
  // When stdin was used to feed the JSONL data we cannot also use it
  // for interactive keystrokes — it's been drained and isn't a TTY.
  // Re-open the controlling terminal directly so the viewer stays
  // usable for `cat run.jsonl | agency logs view -`.
  const restore = opts.stdinIsPipe ? swapStdinToTty() : null;
  const input = new TerminalInput();
  const output = new TerminalOutput();
  const viewport = {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
  try {
    await runViewer({
      jsonl,
      input,
      output,
      viewport,
      followPath: opts.followPath,
      initialFollow: opts.initialFollow ?? false,
    });
  } finally {
    input.destroy();
    if (output.destroy) output.destroy();
    if (restore) restore();
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
