import type { EvalRecord } from "@/eval/types.js";

import type { LoadedRun, JSON } from "./types.js";

/** An eval record with nothing in it. Graders that only read `output` never
 *  touch this; it exists so a LoadedRun in a test is a complete value. */
export const EMPTY_RECORD: EvalRecord = {
  traceId: "test",
  recordVersion: 2,
  formatVersion: 1,
  durationMs: 0,
  startedAtMs: 0,
  source: "test",
  evalValues: [],
  evalOutputs: [],
  threads: [],
  events: [],
  interrupts: [],
  errors: [],
  incomplete: [],
  metrics: {
    llmCalls: 0,
    toolStarts: 0,
    toolEnds: 0,
    models: [],
    tokensInTotal: 0,
    tokensOutTotal: 0,
    costUsdTotal: 0,
    toolCounts: {},
  },
  warnings: [],
};

/** A LoadedRun carrying just an output — for tests of graders that read nothing else. */
export function loadedRun(output: JSON): LoadedRun {
  return { output, traceId: "trace-under-test", workdir: "", record: EMPTY_RECORD };
}
