import { wrapTracesAsRunDirectories, type WrapTracesResult } from "@/runDirectory/mutations.js";

export type RunsAddOptions = {
  /** The group directory; one run directory per trace is written under it. */
  dir: string;
  statelog: string[];
  code: string[];
  workdir?: string;
  trace?: string;
  annotations: string[];
};

export type RunsAddDependencies = { report(message: string): void };

/** Translate the flags into one request, run it once, render the result. */
export function runsAdd(
  options: RunsAddOptions,
  dependencies: RunsAddDependencies = { report: (message) => console.log(message) },
): WrapTracesResult {
  const result = wrapTracesAsRunDirectories(
    {
      groupDir: options.dir,
      statelogFiles: options.statelog,
      trace: options.trace,
      codeEntries: options.code,
      workdir: options.workdir === undefined ? undefined : { sourceDir: options.workdir },
      annotationFiles: options.annotations,
    },
    { reportWarning: (message) => console.warn(message) },
  );
  const lines = [
    ...result.written.map((dir) => `wrote ${dir}`),
    ...result.skipped.map((skip) => `skipped ${skip.traceId}: ${skip.reason}`),
  ];
  dependencies.report(lines.length === 0 ? "No traces to wrap." : lines.join("\n"));
  return result;
}
