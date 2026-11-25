import * as fs from "fs";
import * as path from "path";

export type FakeHarborTrial = {
  name: string;
  taskName: string;
  source: string;
  startedAt: string;
  rewards: Record<string, number> | null;
  exception?: { type: string; message: string };
  statelogLines?: string[];
  agentInfo?: { name: string; model: string };
  agentResult?: {
    input: number | null;
    cache: number | null;
    output: number | null;
    cost: number | null;
  };
  agentExecution?: { startedAt: string; finishedAt: string };
  finishedAt?: string;
  /** Lines of `agent/pi.txt`, Pi's own event log. */
  piLogLines?: string[];
};

/** Write one Harbor trial folder under `jobDir`, the way Harbor lays it out;
 *  returns the trial folder. */
export function writeHarborTrial(jobDir: string, trial: FakeHarborTrial): string {
  const trialDir = path.join(jobDir, trial.name);
  fs.mkdirSync(trialDir, { recursive: true });
  const result = {
    id: `id-${trial.name}`,
    task_name: trial.taskName,
    trial_name: trial.name,
    source: trial.source,
    started_at: trial.startedAt,
    ...(trial.finishedAt === undefined ? {} : { finished_at: trial.finishedAt }),
    ...(trial.agentInfo === undefined
      ? {}
      : {
          agent_info: {
            name: trial.agentInfo.name,
            version: "1.5.2",
            model_info: { name: trial.agentInfo.model, provider: "openrouter" },
          },
        }),
    agent_result:
      trial.agentResult === undefined
        ? null
        : {
            n_input_tokens: trial.agentResult.input,
            n_cache_tokens: trial.agentResult.cache,
            n_output_tokens: trial.agentResult.output,
            cost_usd: trial.agentResult.cost,
            rollout_details: null,
            metadata: null,
          },
    ...(trial.agentExecution === undefined
      ? {}
      : {
          agent_execution: {
            started_at: trial.agentExecution.startedAt,
            finished_at: trial.agentExecution.finishedAt,
          },
        }),
    verifier_result: trial.rewards === null ? null : { rewards: trial.rewards },
    exception_info:
      trial.exception === undefined
        ? null
        : {
            exception_type: trial.exception.type,
            exception_message: trial.exception.message,
            exception_traceback: "Traceback …",
          },
  };
  fs.writeFileSync(path.join(trialDir, "result.json"), JSON.stringify(result, null, 2));
  if (trial.piLogLines !== undefined) {
    fs.mkdirSync(path.join(trialDir, "agent"), { recursive: true });
    fs.writeFileSync(path.join(trialDir, "agent", "pi.txt"), trial.piLogLines.join("\n") + "\n");
  }
  if (trial.statelogLines !== undefined) {
    fs.mkdirSync(path.join(trialDir, "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(trialDir, "agent", "statelog.jsonl"),
      trial.statelogLines.join("\n") + "\n",
    );
  }
  return trialDir;
}

/** The job-level files Harbor writes beside its trial folders. */
export function writeHarborJobFiles(jobDir: string): void {
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "config.json"), "{}");
  fs.writeFileSync(path.join(jobDir, "job.log"), "log\n");
  fs.writeFileSync(path.join(jobDir, "lock.json"), "{}");
  fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify({ id: "job", stats: {} }));
}
