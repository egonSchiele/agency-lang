import * as fs from "fs";
import * as path from "path";

import { matchTrace, readTraces, type Trace, type TraceMatch } from "./traces.js";

/** Find one trace in a statelog by full id or unique prefix. */
export function findTrace(statelogPath: string, idOrPrefix: string): TraceMatch {
  return matchTrace(readTraces(statelogPath).traces, idOrPrefix);
}

export type WriteTraceFileArgs = {
  trace: Trace;
  outPath: string;
  /** The statelog the trace came from; the output may never be that file. */
  sourcePath: string;
  /** Replace an existing output file. Off by default: an existing file is
   *  refused, so a mistyped path cannot destroy something. */
  overwrite?: boolean;
};

/**
 * Write one trace as a statelog of its own: its lines exactly as they appear
 * in the source, so everything downstream reads the slice unchanged. The two
 * things `readTraces` already drops (a torn final line, and a line that is a
 * byte-identical repeat of an earlier one in the same trace) are not written.
 *
 * Creation is exclusive by default. Overwriting the source is refused even
 * with `overwrite`, since that would replace a whole log with one trace.
 */
export function writeTraceFile(args: WriteTraceFileArgs): void {
  const resolvedOut = path.resolve(args.outPath);
  if (fs.existsSync(args.sourcePath) && sameFile(resolvedOut, path.resolve(args.sourcePath))) {
    throw new Error(
      `Refusing to write the extracted trace over its own source ${args.sourcePath}.`,
    );
  }
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  const text = args.trace.lines.join("\n") + "\n";
  if (args.overwrite === true) {
    fs.writeFileSync(resolvedOut, text);
    return;
  }
  try {
    fs.writeFileSync(resolvedOut, text, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`${args.outPath} already exists; pass --overwrite to replace it.`);
  }
}

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    // One of them does not exist yet, so they cannot be the same file.
    return false;
  }
}
