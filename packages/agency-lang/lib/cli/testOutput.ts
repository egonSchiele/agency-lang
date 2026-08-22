/** Where `agency test` prints. Under `--json`, stdout carries exactly one
 *  document and every human line goes to stderr. */
import type { TestReport } from "./testReport.js";

export type OutputStream = "stdout" | "stderr";

export type TestOutput = {
  kind: "human" | "json";
  /** A human-readable line. Defaults to stdout. */
  line(msg: string, stream?: OutputStream): void;
  /** The document, once, at the end. A no-op in human mode. */
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

export function humanOutput(writers: OutputWriters = processWriters): TestOutput {
  return {
    kind: "human",
    line: (msg, stream = "stdout") => writers[stream](`${msg}\n`),
    document: () => {},
  };
}

export function jsonOutput(writers: OutputWriters = processWriters): TestOutput {
  return {
    kind: "json",
    line: (msg) => writers.stderr(`${msg}\n`),
    document: (report) => writers.stdout(`${JSON.stringify(report)}\n`),
  };
}
