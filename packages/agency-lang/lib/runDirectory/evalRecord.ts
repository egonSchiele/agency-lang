import { extractEvalRecord } from "@/eval/extract.js";
import type { EvalRecord } from "@/eval/types.js";

import type { EventEnvelope } from "@/statelog/wireTypes.js";

import type { Trace } from "./traces.js";

/** The eval record for one trace, computed on demand — it is a view of the
 *  statelog for graders and judges, never a file. */
export function evalRecordFor(trace: Trace, sourcePath: string): EvalRecord {
  return extractEvalRecord(trace.events, sourcePath);
}

export type TraceEnding = "ok" | "error" | "unknown";

/** How a trace ended, read from its own events: an `agentEnd` carrying a
 *  result is a clean finish; a result-less `agentEnd` after a `runtimeError`
 *  is a crash; no `agentEnd` at all is unknown (killed, still running, or
 *  captured mid-flight). The harness's `run` annotation, when present, knows
 *  more than this. */
export function traceEnding(trace: { events: readonly EventEnvelope[] }): TraceEnding {
  const ends = trace.events.filter((event) => event.data.type === "agentEnd");
  const last = ends.at(-1);
  if (last === undefined) return "unknown";
  if (last.data.result !== undefined && last.data.result !== null) return "ok";
  const crashed = trace.events.some(
    (event) => event.data.type === "error" && event.data.errorType === "runtimeError",
  );
  return crashed ? "error" : "ok";
}
