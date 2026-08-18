import * as fs from "fs";
import * as path from "path";

import { matchTrace, readTraces, type Trace, type TraceMatch } from "./traces.js";

/** Find one trace in a statelog by full id or unique prefix. */
export function findTrace(statelogPath: string, idOrPrefix: string): TraceMatch {
  return matchTrace(readTraces(statelogPath).traces, idOrPrefix);
}

/** Write one trace's lines, verbatim, as a statelog of its own. A trace slice
 *  is a valid statelog, so everything downstream reads it unchanged. */
export function writeTraceFile(trace: Trace, outPath: string): void {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, trace.lines.join("\n") + "\n");
}
