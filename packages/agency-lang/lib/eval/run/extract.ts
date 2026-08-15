import * as fs from "fs";
import * as path from "path";

import { StatelogParser } from "@/eval/statelogParser.js";

/** How to turn a written statelog into an eval-record.json. Failures are
 *  caught by the caller and routed into the run result. */
export type EvalRecordExtractor = (args: {
  statelogPath: string;
  outPath: string;
}) => Promise<void>;

/** The standard extractor: parse the statelog, write the record as JSON.
 *  `warnMissingValue: true` warns when the run recorded no `evalValue()`;
 *  the optimizer passes false because its inputs come from the input spec,
 *  so a run without `evalValue()` is normal there, not a mistake. */
export function makeEvalRecordExtractor(options: {
  warnMissingValue: boolean;
}): EvalRecordExtractor {
  return async ({ statelogPath, outPath }) => {
    const record = new StatelogParser(statelogPath, options).evalRecord();
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
  };
}

export function shouldExtractStatelog(statelogPath: string): boolean {
  try {
    return fs.statSync(statelogPath).size > 0;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export type AgentRunPaths = {
  agentDir: string;
  statelogPath: string;
  evalRecordPath: string;
  errorPath: string;
  workdirPath: string;
};

/** The one place the inside-a-run-directory layout is written down: records
 *  about the run under agent/, the agent's own working directory beside it. */
export function agentRunPaths(runDir: string): AgentRunPaths {
  const agentDir = path.join(runDir, "agent");
  return {
    agentDir,
    statelogPath: path.join(agentDir, "statelog.jsonl"),
    evalRecordPath: path.join(agentDir, "eval-record.json"),
    errorPath: path.join(agentDir, "error.txt"),
    workdirPath: path.join(runDir, "workdir"),
  };
}
