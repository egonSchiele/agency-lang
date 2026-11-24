import type { RunOutcome, RunPayload } from "@/runDirectory/annotations.js";
import type { ScoreDraft } from "@/runDirectory/mutations.js";
import { sha256Text } from "@/utils/hash.js";

import type { HarborTrial } from "./readTrials.js";

/** With no reward, these mean the agent failed: the trial scores 0. */
const AGENT_FAULT = ["AgentTimeoutError", "NonZeroAgentExitCodeError"];

/** With no reward, these mean the setup failed: the trial is void. Any type
 *  in neither list is void too, and is named in the import's output. */
const KNOWN_VOID = [
  "DaytonaError",
  "CancelledError",
  "VerifierTimeoutError",
  "RewardFileNotFoundError",
  "NetworkConnectionError",
  // Harbor's own failures, such as "Agent install failed".
  "RuntimeError",
];

export type PlannedScore = Pick<ScoreDraft, "name" | "score">;

export type PlannedRun = {
  trial: HarborTrial;
  /** `<testId>/<trial>`, under `<out>/<batch>/`. */
  relativeDir: string;
  payload: RunPayload;
  /** Empty when the trial is unscored. */
  scores: PlannedScore[];
  /** A stable trace id for a trial with no trace; null when it has one. */
  silentTraceId: string | null;
};

export type ImportPlan = {
  batch: string;
  runs: PlannedRun[];
  /** Trials per test → the tests with that many, in input order. */
  trialCounts: Record<number, string[]>;
  /** Exception types outside both lists that made a trial void; sorted. */
  unknownExceptions: string[];
};

/** Void: the run failed for reasons outside the agent, so it doesn't count. */
export function isVoid(trial: HarborTrial): boolean {
  if (trial.statelogPath === null) {
    return true;
  }
  if (trial.rewards !== null) {
    return false;
  }
  return trial.exception === null || !AGENT_FAULT.includes(trial.exception.type);
}

export function scoresOf(trial: HarborTrial): PlannedScore[] {
  if (isVoid(trial)) {
    return [];
  }
  if (trial.rewards === null) {
    return [{ name: "reward", score: { kind: "binary", pass: false } }];
  }
  return Object.entries(trial.rewards).map(([name, value]) => ({
    name,
    score:
      value === 0 || value === 1
        ? { kind: "binary", pass: value === 1 }
        : { kind: "scalar", value },
  }));
}

export function endedOf(trial: HarborTrial): RunOutcome {
  if (isVoid(trial)) {
    return "void";
  }
  switch (trial.exception?.type) {
    case undefined:
      return "ok";
    case "AgentTimeoutError":
      return "timeout";
    case "CancelledError":
      return "killed";
    default:
      return "error";
  }
}

/** Turns trials, in input order, into the run rows and scores to write. */
export function planHarborImport({
  trials,
  batch,
  reasoning,
}: {
  trials: HarborTrial[];
  batch: string;
  reasoning?: string;
}): ImportPlan {
  const trialsPerTest: Record<string, number> = {};
  const runs = trials.map((trial): PlannedRun => {
    const number = (trialsPerTest[trial.testId] ?? 0) + 1;
    trialsPerTest[trial.testId] = number;
    return {
      trial,
      relativeDir: `${trial.testId}/${number}`,
      payload: payloadOf({ trial, batch, number, reasoning }),
      scores: scoresOf(trial),
      silentTraceId: trial.statelogPath === null ? silentTraceIdOf(trial) : null,
    };
  });
  return {
    batch,
    runs,
    trialCounts: countsOf(trialsPerTest),
    unknownExceptions: unknownExceptionsOf(trials),
  };
}

function payloadOf({
  trial,
  batch,
  number,
  reasoning,
}: {
  trial: HarborTrial;
  batch: string;
  number: number;
  reasoning?: string;
}): RunPayload {
  const payload: RunPayload = {
    kind: "run",
    test: { id: trial.testId },
    suite: null,
    ended: endedOf(trial),
    flags: { harborJob: trial.jobName, harborTrial: trial.trialName },
    batch,
    trial: number,
    benchmark: trial.benchmark,
  };
  if (trial.exception !== null) {
    payload.error = `${trial.exception.type}: ${trial.exception.message}`;
  }
  if (reasoning !== undefined) {
    payload.reasoning = reasoning;
  }
  return payload;
}

/** Names, not paths, so the id doesn't depend on where the job lives. */
function silentTraceIdOf(trial: HarborTrial): string {
  return `harbor-${sha256Text(`${trial.jobName}/${trial.trialName}`).slice(0, 24)}`;
}

function countsOf(trialsPerTest: Record<string, number>): Record<number, string[]> {
  const counts: Record<number, string[]> = {};
  for (const [testId, count] of Object.entries(trialsPerTest)) {
    (counts[count] ??= []).push(testId);
  }
  return counts;
}

function unknownExceptionsOf(trials: HarborTrial[]): string[] {
  const types = trials
    .filter(isVoid)
    .flatMap((trial) => (trial.exception === null ? [] : [trial.exception.type]))
    .filter((type) => !AGENT_FAULT.includes(type) && !KNOWN_VOID.includes(type));
  return types.filter((type, index) => types.indexOf(type) === index).sort();
}
