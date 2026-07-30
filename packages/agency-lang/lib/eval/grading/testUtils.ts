import type { EvalRecord } from "@/eval/types.js";

import type { AgentRun, JSON } from "./types.js";

/** An eval record with nothing in it. Graders that only read `output` never
 *  touch this; it exists so an AgentRun in a test is a complete value. */
export const EMPTY_RECORD: EvalRecord = {
  traceId: "test",
  recordVersion: 2,
  formatVersion: 1,
  durationMs: 0,
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

/** An AgentRun carrying just an output — for tests of graders that read nothing else. */
export function agentRun(output: JSON): AgentRun {
  return { output, recordPath: "", workdir: "", record: EMPTY_RECORD };
}
