import * as fs from "fs";
import * as path from "path";

import { harnessVersion } from "@/eval/harnessVersion.js";
import { agentNameProblem } from "@/statelog/agentName.js";
import type { Annotation, Annotator } from "@/runDirectory/annotations.js";
import { recordCompletedRun, recordGradingPass } from "@/runDirectory/mutations.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";
import { readTracesOrThrow } from "@/runDirectory/traces.js";

import { planHarborImport, type ImportPlan, type PlannedRun } from "./planImport.js";
import { isSafeFolderName, readHarborInputs, type HarborProblem } from "./readTrials.js";

export type ImportOutcome =
  | { status: "imported" | "present" | "scored"; dir: string }
  | { status: "failed"; path: string; error: string };

export type ImportResult = {
  plan: ImportPlan;
  outcomes: ImportOutcome[];
  problems: HarborProblem[];
  /** `<out>/<batch>`: what to pass to `agency eval upload`. */
  uploadPath: string;
};

const quiet = { reportWarning: (): void => {} };

/** Converts the Harbor trials given into run folders under
 *  `<outDir>/<batch>/<test>/<trial>/`. Re-running is safe: a folder that
 *  already holds the same trial is left alone or only gets its scores. */
export function importHarbor({
  jobDirs,
  trialsFile,
  outDir,
  batch,
  reasoning,
  agent,
  reportProgress = (): void => {},
}: {
  jobDirs: string[];
  trialsFile?: string;
  outDir: string;
  batch?: string;
  reasoning?: string;
  /** Names every run's agent, over the trace's own name. */
  agent?: string;
  /** Called once per trial, as `[n/total] <status> <test>/<trial>`. */
  reportProgress?: (line: string) => void;
}): ImportResult {
  const batchName = batchNameOf({ jobDirs, trialsFile, batch });
  const agentProblem = agent === undefined ? null : agentNameProblem(agent);
  if (agentProblem !== null) {
    throw new Error(`import-harbor: --agent ${agentProblem}`);
  }
  const { trials, problems } = readHarborInputs({ jobDirs, trialsFile });
  const plan = planHarborImport({ trials, batch: batchName, reasoning, agent });
  const uploadPath = path.join(outDir, batchName);
  const outcomes = plan.runs.map((run, index) => {
    const outcome = writeRun({ run, dir: path.join(uploadPath, run.relativeDir) });
    reportProgress(`[${index + 1}/${plan.runs.length}] ${outcome.status} ${run.relativeDir}`);
    return outcome;
  });
  return { plan, outcomes, problems, uploadPath };
}

function batchNameOf({
  jobDirs,
  trialsFile,
  batch,
}: {
  jobDirs: string[];
  trialsFile?: string;
  batch?: string;
}): string {
  if (batch !== undefined) {
    if (!isSafeFolderName(batch)) {
      throw new Error("import-harbor: --batch must be one plain folder name");
    }
    return batch;
  }
  if (jobDirs.length === 1 && trialsFile === undefined) {
    return path.basename(path.resolve(jobDirs[0]));
  }
  throw new Error("import-harbor: --batch is required unless importing one job folder");
}

function writeRun({ run, dir }: { run: PlannedRun; dir: string }): ImportOutcome {
  try {
    const existing = existingRunRow(dir);
    if (existing !== null) {
      return finishExisting({ run, dir, existing });
    }
    const traceId = writeRunRow({ run, dir });
    writeScores({ run, dir, traceId });
    return { status: "imported", dir };
  } catch (error) {
    return {
      status: "failed",
      path: dir,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type ExistingRun = { row: Annotation & { kind: "run" }; gradingPasses: number };

function existingRunRow(dir: string): ExistingRun | null {
  if (!fs.existsSync(dir)) {
    return null;
  }
  const snapshot = readRunDirectory(dir, quiet);
  for (const effective of Object.values(snapshot.effectiveAnnotations)) {
    const row = effective.run;
    if (row !== null && row.kind === "run") {
      return { row, gradingPasses: effective.gradingPasses };
    }
  }
  return null;
}

function finishExisting({
  run,
  dir,
  existing,
}: {
  run: PlannedRun;
  dir: string;
  existing: ExistingRun;
}): ImportOutcome {
  const { harborJob, harborTrial } = existing.row.flags;
  if (harborJob === undefined || harborTrial === undefined) {
    throw new Error(`${dir} already holds a run that wasn't imported from Harbor.`);
  }
  const wanted = `${run.trial.jobName}/${run.trial.trialName}`;
  const found = `${harborJob}/${harborTrial}`;
  if (found !== wanted) {
    throw new Error(
      `${dir} holds Harbor trial ${found}, but this import puts ${wanted} there. ` +
        `The input changed order or contents; delete the batch folder and import again.`,
    );
  }
  const oldAgent = existing.row.agentName ?? existing.row.flags.agent;
  const newAgent = run.payload.agentName ?? run.payload.flags.agent;
  if (oldAgent !== newAgent) {
    throw new Error(
      `${dir} was imported with agent ${String(oldAgent ?? "(none)")}; this import names ` +
        `${String(newAgent ?? "(none)")}. Delete the batch folder and import again.`,
    );
  }
  if (existing.gradingPasses > 0 || run.scores.length === 0) {
    return { status: "present", dir };
  }
  writeScores({ run, dir, traceId: existing.row.traceId });
  return { status: "scored", dir };
}

/** Writes the trace (if any) and the `run` row; returns the trace id. */
function writeRunRow({ run, dir }: { run: PlannedRun; dir: string }): string {
  fs.mkdirSync(dir, { recursive: true });
  const traceId = run.silentTraceId ?? singleTraceIdOf(run);
  if (run.trial.statelogPath === null) {
    // Discovery recognizes a run folder by its statelog, as `eval run`
    // writes for a run that never started (runSuite.ts).
    // Append mode: never empties a statelog an earlier, cut-off import left.
    fs.writeFileSync(runDirPaths(dir).statelog, "", { flag: "a" });
  }
  recordCompletedRun({
    dir,
    stagedStatelogFile: run.trial.statelogPath ?? undefined,
    run: { traceId, annotator: harnessAnnotator(), payload: run.payload },
  });
  return traceId;
}

function singleTraceIdOf(run: PlannedRun): string {
  const statelogPath = run.trial.statelogPath ?? "";
  const traces = readTracesOrThrow(statelogPath);
  if (traces.length !== 1) {
    throw new Error(
      `${statelogPath} holds ${traces.length} traces; a Harbor trial must hold exactly one.`,
    );
  }
  return traces[0].traceId;
}

function writeScores({
  run,
  dir,
  traceId,
}: {
  run: PlannedRun;
  dir: string;
  traceId: string;
}): void {
  if (run.scores.length === 0) {
    return;
  }
  const annotator: Annotator = { kind: "grader", id: `harbor-verifier:${run.trial.benchmark}` };
  recordGradingPass({
    dir,
    scores: run.scores.map((score) => ({
      ...score,
      traceId,
      annotator,
      weight: 1,
      mustPass: false,
    })),
  });
}

function harnessAnnotator(): Annotator {
  return { kind: "harness", id: `harbor-import@${harnessVersion()}` };
}
