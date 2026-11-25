import * as fs from "fs";
import * as path from "path";

import { z } from "zod";

import type { RunReported } from "@/runDirectory/annotations.js";

/** One Harbor trial, as far as the import needs it. */
export type HarborTrial = {
  /** The job folder's name. */
  jobName: string;
  /** The trial folder's name. */
  trialName: string;
  /** `task_name` after its first "/". */
  testId: string;
  /** `result.json`'s `source`. */
  benchmark: string;
  startedAt: string;
  rewards: Record<string, number> | null;
  exception: { type: string; message: string } | null;
  /** `<trial>/agent/statelog.jsonl`, or null when the agent never started. */
  statelogPath: string | null;
  /** `agent_info.name`, such as "pi" or "agency-agent". */
  agentName: string | null;
  /** The usage and times the agent reported, when it reported tokens. Pi
   *  does; the Agency agent's usage is in its trace instead. */
  reported: RunReported | null;
};

export type HarborProblem = { path: string; reason: string };

export type ReadTrialResult =
  { ok: true; trial: HarborTrial } | { ok: false; problem: HarborProblem };

/** Harbor publishes no schema; these are the only fields the import reads. */
const HarborTimesSchema = z.looseObject({
  started_at: z.string().min(1),
  finished_at: z.string().min(1),
});

const HarborResultSchema = z.looseObject({
  task_name: z.string().min(1),
  source: z.string().min(1),
  started_at: z.string().min(1),
  finished_at: z.string().min(1).nullish(),
  agent_info: z
    .looseObject({
      name: z.string().min(1),
      model_info: z.looseObject({ name: z.string().min(1) }).nullish(),
    })
    .nullish(),
  agent_result: z
    .looseObject({
      n_input_tokens: z.number().nullish(),
      n_cache_tokens: z.number().nullish(),
      n_output_tokens: z.number().nullish(),
      cost_usd: z.number().nullish(),
    })
    .nullish(),
  agent_execution: HarborTimesSchema.nullish(),
  verifier_result: z
    .looseObject({ rewards: z.record(z.string(), z.number()).nullable() })
    .nullable(),
  exception_info: z
    .looseObject({ exception_type: z.string(), exception_message: z.string() })
    .nullable(),
});

type HarborResult = z.infer<typeof HarborResultSchema>;

export function readHarborTrial(trialDir: string): ReadTrialResult {
  const resultPath = path.join(trialDir, "result.json");
  if (!fs.existsSync(resultPath)) {
    return problemAt(trialDir, "no result.json: Harbor stopped before finishing this trial");
  }
  const parsed = parseResult(resultPath);
  if (!parsed.ok) {
    return problemAt(trialDir, parsed.reason);
  }
  const testId = testIdOf(parsed.result.task_name);
  if (!isSafeFolderName(testId)) {
    return problemAt(
      trialDir,
      `task name "${parsed.result.task_name}" can't be used as a folder name`,
    );
  }
  return { ok: true, trial: trialOf({ trialDir, result: parsed.result, testId }) };
}

/** Job folders in argument order, each one's trials by start time, then the
 *  trials file's lines in order. The same trial twice is a problem, not a
 *  second trial. */
export function readHarborInputs({
  jobDirs,
  trialsFile,
}: {
  jobDirs: string[];
  trialsFile?: string;
}): { trials: HarborTrial[]; problems: HarborProblem[] } {
  const reads = [
    ...jobDirs.flatMap(readJob),
    ...(trialsFile === undefined ? [] : readTrialsFile(trialsFile)),
  ];
  const trials: HarborTrial[] = [];
  const problems: HarborProblem[] = [];
  const seen: Record<string, true> = Object.create(null);
  for (const read of reads) {
    if (!read.result.ok) {
      problems.push(read.result.problem);
      continue;
    }
    const key = fs.realpathSync(read.dir);
    if (seen[key]) {
      problems.push({ path: read.label, reason: `${read.dir} is listed twice` });
      continue;
    }
    seen[key] = true;
    trials.push(read.result.trial);
  }
  return { trials, problems };
}

/** One input trial: where it came from (`label`, for problems) and what it read. */
type TrialRead = { label: string; dir: string; result: ReadTrialResult };

function readJob(jobDir: string): TrialRead[] {
  if (!isDirectory(jobDir)) {
    return [{ label: jobDir, dir: jobDir, result: problemAt(jobDir, "not a folder") }];
  }
  const reads = fs
    .readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(jobDir, entry.name))
    .map((dir) => ({ label: dir, dir, result: readHarborTrial(dir) }));
  return reads.sort(byStartThenName);
}

function byStartThenName(left: TrialRead, right: TrialRead): number {
  const leftKey = sortKeyOf(left);
  const rightKey = sortKeyOf(right);
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
}

/** Problems sort first, by folder; trials by start time, then folder name. */
function sortKeyOf(read: TrialRead): string {
  if (!read.result.ok) {
    return `0 ${path.basename(read.dir)}`;
  }
  return `1 ${read.result.trial.startedAt} ${read.result.trial.trialName}`;
}

function readTrialsFile(trialsFile: string): TrialRead[] {
  if (!fs.existsSync(trialsFile)) {
    return [{ label: trialsFile, dir: trialsFile, result: problemAt(trialsFile, "no such file") }];
  }
  const base = path.dirname(path.resolve(trialsFile));
  const lines = fs.readFileSync(trialsFile, "utf8").split("\n");
  return lines.flatMap((line, index) => {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) {
      return [];
    }
    const label = `${trialsFile}:${index + 1}`;
    const dir = path.resolve(base, text);
    return [{ label, dir, result: readListedTrial({ label, dir }) }];
  });
}

/** A trials-file line's problems name the line, so it can be found and fixed. */
function readListedTrial({ label, dir }: { label: string; dir: string }): ReadTrialResult {
  if (!isDirectory(dir)) {
    return problemAt(label, `${dir} is not a folder`);
  }
  const result = readHarborTrial(dir);
  if (result.ok) {
    return result;
  }
  return problemAt(label, `${dir}: ${result.problem.reason}`);
}

function parseResult(
  resultPath: string,
): { ok: true; result: HarborResult } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch (error) {
    return { ok: false, reason: `result.json is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = HarborResultSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `result.json doesn't match: ${fields}` };
  }
  return { ok: true, result: parsed.data };
}

function trialOf({
  trialDir,
  result,
  testId,
}: {
  trialDir: string;
  result: HarborResult;
  testId: string;
}): HarborTrial {
  const absolute = path.resolve(trialDir);
  const statelogPath = path.join(trialDir, "agent", "statelog.jsonl");
  const exception = result.exception_info;
  return {
    jobName: path.basename(path.dirname(absolute)),
    trialName: path.basename(absolute),
    testId,
    benchmark: result.source,
    startedAt: result.started_at,
    rewards: result.verifier_result?.rewards ?? null,
    exception:
      exception === null
        ? null
        : { type: exception.exception_type, message: exception.exception_message },
    // An empty statelog means the agent never logged anything: no trace.
    statelogPath:
      fs.existsSync(statelogPath) && fs.statSync(statelogPath).size > 0 ? statelogPath : null,
    agentName: result.agent_info?.name ?? null,
    reported: reportedOf({ result, trialDir }),
  };
}

/** Null unless the agent reported its tokens. `n_input_tokens` includes the
 *  cached tokens, so fresh input is the difference. */
function reportedOf({
  result,
  trialDir,
}: {
  result: HarborResult;
  trialDir: string;
}): RunReported | null {
  const usage = result.agent_result;
  const input = usage?.n_input_tokens;
  const output = usage?.n_output_tokens;
  if (typeof input !== "number" || typeof output !== "number") {
    return null;
  }
  const cached = usage?.n_cache_tokens ?? 0;
  const times = agentTimes({ log: piLogTimes(trialDir), harbor: harborTimes(result) });
  return {
    models: [
      {
        name: result.agent_info?.model_info?.name ?? "unknown",
        reasoning: null,
        calls: 0,
        inputTokens: input - cached,
        cachedInputTokens: cached,
        cacheCreationInputTokens: 0,
        outputTokens: output,
        costUsd: usage?.cost_usd ?? 0,
      },
    ],
    startedAtMs: Date.parse(times.startedAt),
    durationMs: Date.parse(times.finishedAt) - Date.parse(times.startedAt),
    lastEventAt: times.finishedAt,
  };
}

type AgentTimes = { startedAt: string; finishedAt: string };

/** Beyond this, Pi's log missed the end of the run rather than Harbor adding
 *  its usual overhead of about 12 seconds. */
const PI_LOG_MAX_GAP_MS = 60_000;

/** Pi's log, the same basis as an Agency trace, unless it missed the end:
 *  Pi stamps a message when it starts, so a final long message or a hang
 *  until the timeout is invisible in it. */
function agentTimes({ log, harbor }: { log: AgentTimes | null; harbor: AgentTimes }): AgentTimes {
  if (log === null || durationOf(harbor) - durationOf(log) > PI_LOG_MAX_GAP_MS) {
    return harbor;
  }
  return log;
}

function durationOf(times: AgentTimes): number {
  return Date.parse(times.finishedAt) - Date.parse(times.startedAt);
}

/** The first and last timestamps in Pi's own log, `agent/pi.txt`. Harbor's
 *  agent time adds about 12 seconds of harness work; an Agency run's time
 *  comes from its trace, so Pi's comes from its log. Null without at least
 *  two timestamps. */
function piLogTimes(trialDir: string): AgentTimes | null {
  const logPath = path.join(trialDir, "agent", "pi.txt");
  if (!fs.existsSync(logPath)) {
    return null;
  }
  const stamps = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .flatMap((line) => timestampOf(line));
  if (stamps.length < 2) {
    return null;
  }
  return {
    startedAt: new Date(Math.min(...stamps)).toISOString(),
    finishedAt: new Date(Math.max(...stamps)).toISOString(),
  };
}

/** A Pi log line's time in milliseconds: the session line's ISO `timestamp`,
 *  or a message's epoch-millisecond `message.timestamp`. */
function timestampOf(line: string): number[] {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof row !== "object" || row === null) {
    return [];
  }
  const record = row as { timestamp?: unknown; message?: { timestamp?: unknown } };
  const value = record.timestamp ?? record.message?.timestamp;
  const ms = typeof value === "string" ? Date.parse(value) : value;
  return typeof ms === "number" && Number.isFinite(ms) ? [ms] : [];
}

/** The agent's run as Harbor timed it, else the whole trial's; ISO strings
 *  with milliseconds, like trace timestamps. */
function harborTimes(result: HarborResult): AgentTimes {
  const startedAt = result.agent_execution?.started_at ?? result.started_at;
  const finishedAt = result.agent_execution?.finished_at ?? result.finished_at ?? startedAt;
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
  };
}

/** `swe-bench/astropy__astropy-12907` → `astropy__astropy-12907`. */
function testIdOf(taskName: string): string {
  const slash = taskName.indexOf("/");
  return slash === -1 ? taskName : taskName.slice(slash + 1);
}

function problemAt(problemPath: string, reason: string): ReadTrialResult {
  return { ok: false, problem: { path: problemPath, reason } };
}

/** A test id or batch name becomes a folder, so it must be one plain name. */
export function isSafeFolderName(testId: string): boolean {
  return testId !== "" && testId !== "." && !testId.includes("/") && !testId.includes("..");
}

function isDirectory(dir: string): boolean {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}
