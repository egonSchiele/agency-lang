/**
 * Where the `agency test` command's output goes. Every human-readable line
 * the command prints passes through one of these, so that under `--json`
 * stdout can carry exactly one document and nothing else.
 */
import type { TestReport } from "./testReport.js";

export type OutputStream = "stdout" | "stderr";

export type TestOutput = {
  /** A human-readable line. Defaults to stdout. */
  line(msg: string, stream?: OutputStream): void;
  /** The machine-readable document, once, at the end. A no-op in human mode. */
  document(report: TestReport): void;
};

export type OutputWriters = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const processWriters: OutputWriters = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** Today's behavior: lines go where they were asked to; no document. */
export function humanOutput(writers: OutputWriters = processWriters): TestOutput {
  return {
    line: (msg, stream = "stdout") => writers[stream](`${msg}\n`),
    document: () => {},
  };
}

/** `--json`: every line goes to stderr; stdout receives the document only. */
export function jsonOutput(writers: OutputWriters = processWriters): TestOutput {
  return {
    line: (msg) => writers.stderr(`${msg}\n`),
    document: (report) => writers.stdout(`${JSON.stringify(report)}\n`),
  };
}
