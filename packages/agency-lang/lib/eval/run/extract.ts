import * as fs from "fs";
import * as path from "path";

/** True when a statelog exists and is non-empty. ENOENT is "no"; anything
 *  else is a real error. */
export function hasStatelog(statelogPath: string): boolean {
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
  workdirPath: string;
};

/** The one place a run's STAGING layout is written down: the statelog under
 *  agent/, the agent's own working directory beside it. The suite folds both
 *  into the run directory when the run finishes. */
export function agentRunPaths(runDir: string): AgentRunPaths {
  const agentDir = path.join(runDir, "agent");
  return {
    agentDir,
    statelogPath: path.join(agentDir, "statelog.jsonl"),
    workdirPath: path.join(runDir, "workdir"),
  };
}
