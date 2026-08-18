import { addToRunDirectory, type AddToRunDirectoryResult } from "@/runDirectory/mutations.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";
import { readTraces } from "@/runDirectory/traces.js";

import { formatRunsList } from "./list.js";

export type RunsAddOptions = {
  dir: string;
  statelog: string[];
  code: string[];
  workdir?: string;
  trace?: string;
  annotations: string[];
  replace?: boolean;
};

export type RunsAddDependencies = { report(message: string): void };

/** Translate the flags into one request, run it once, render the result. */
export function runsAdd(
  options: RunsAddOptions,
  dependencies: RunsAddDependencies = { report: (message) => console.log(message) },
): AddToRunDirectoryResult {
  const workdir = workdirRequest(options);
  const result = addToRunDirectory(
    {
      dir: options.dir,
      statelogFiles: options.statelog,
      codeEntries: options.code,
      workdir,
      annotationFiles: options.annotations,
    },
    { reportWarning: (message) => console.warn(message) },
  );
  dependencies.report(
    [
      `Updated ${options.dir}:`,
      `  statelog traces: ${result.statelogSummary}`,
      `  code versions:   ${result.code.added} added, ${result.code.skipped} already present`,
      `  workdirs:        ${result.workdirs.added} added`,
      `  annotations:     ${result.annotations.added} added, ${result.annotations.skipped} already present`,
      "",
      formatRunsList(result.snapshot),
    ].join("\n"),
  );
  return result;
}

function workdirRequest(options: RunsAddOptions) {
  if (options.workdir === undefined) return undefined;
  const traceId = options.trace ?? singleTraceId(options);
  return { traceId, sourceDir: options.workdir, replace: options.replace === true };
}

/** `--workdir` without `--trace` is fine when the directory (after the
 *  statelogs being added) will hold exactly one trace. */
function singleTraceId(options: RunsAddOptions): string {
  const known = readRunDirectory(options.dir, { reportWarning: () => {} }).traces.map(
    (trace) => trace.traceId,
  );
  const ids = [...known];
  for (const file of options.statelog) {
    for (const trace of readTraces(file).traces) {
      if (!ids.includes(trace.traceId)) ids.push(trace.traceId);
    }
  }
  if (ids.length === 1) return ids[0];
  throw new Error(
    ids.length === 0
      ? "--workdir needs a trace to attach to; add a statelog first or pass --trace <id>."
      : `--workdir needs --trace <id>: the directory holds ${ids.length} traces (${ids.join(", ")}).`,
  );
}
