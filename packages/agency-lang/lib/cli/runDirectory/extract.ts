import * as fs from "fs";
import * as path from "path";

import { matchTrace, readTraces, type Trace } from "@/runDirectory/traces.js";

import { describeTraces } from "./traceListing.js";

export type LogsExtractOptions = { log: string; trace?: string; out?: string };

export type LogsExtractDependencies = { writeStdout(text: string): void };

const defaultDependencies: LogsExtractDependencies = {
  writeStdout: (text) => process.stdout.write(text),
};

/**
 * Copy one trace's lines out of a statelog, verbatim, to a file or stdout. A
 * trace slice is itself a valid statelog, so this is the primitive that turns
 * "a run I noticed in a big log" into "a run I can attach things to".
 */
export function logsExtract(
  options: LogsExtractOptions,
  dependencies: LogsExtractDependencies = defaultDependencies,
): { traceId: string; lines: number } {
  const trace = pickTrace(options);
  const text = trace.lines.join("\n") + "\n";
  if (options.out === undefined) {
    dependencies.writeStdout(text);
  } else {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, text);
  }
  return { traceId: trace.traceId, lines: trace.lines.length };
}

/** With no `--trace`, a single-trace log needs no choosing; several do. */
export function pickTrace(options: { log: string; trace?: string }): Trace {
  const { traces } = readTraces(options.log);
  if (traces.length === 0) {
    throw new Error(`${options.log} holds no traces.`);
  }
  if (options.trace === undefined) {
    if (traces.length === 1) return traces[0];
    throw new Error(
      `${options.log} holds ${traces.length} traces; say which with --trace <id>.\n` +
        describeTraces(traces, options.log),
    );
  }
  const match = matchTrace(traces, options.trace);
  if (match.kind === "one") return match.trace;
  if (match.kind === "none") {
    throw new Error(
      `No trace in ${options.log} matches "${options.trace}".\n${describeTraces(traces, options.log)}`,
    );
  }
  throw new Error(
    `Trace id "${options.trace}" is ambiguous — it matches ${match.ids.length} traces:\n` +
      match.ids.map((id) => `  ${id}`).join("\n") +
      "\nUse more characters to pick one.",
  );
}
