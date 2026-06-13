import * as fs from "fs";
import * as path from "path";

import { evalRunLoadedTasks } from "@/cli/eval/run.js";
import type { AgencyConfig } from "@/config.js";
import { judgeSuite, type JudgeSuiteArgs } from "@/eval/judge/suite.js";
import type { SuiteVerdict } from "@/eval/judge/types.js";
import type { EvalRunResult, EvalTask } from "@/eval/runTypes.js";

import { createOptimizeArtifacts, sha256Text, type OptimizeArtifacts } from "./artifacts.js";
import { buildMutationHistory, type MutationHistoryEntry } from "./history.js";
import { proposeMutation, type ProposeMutationArgs } from "./mutator.js";
import { SILENT_OPTIMIZE_REPORTER, type OptimizeReporter, type TaskRecordPair } from "./reporter.js";
import {
  OptimizeSourceMutator,
  type OptimizeMutationDiagnostic,
  type OptimizeMutationPreview,
} from "./sourceMutator.js";
import { normalizeOptimizeTasks } from "./tasks.js";
import type { OptimizeTargetSet } from "./targets.js";
import type {
  IterationResult,
  MutationProposal,
  OptimizeLoopConfig,
  OptimizeResult,
} from "./types.js";

export type OptimizeLoopDeps = {
  /** Presentation boundary; defaults to a silent reporter. */
  reporter?: OptimizeReporter;
  /** Pipe candidate agents' stdout/stderr through to the console. */
  pipeAgentOutput?: boolean;
  mutate?: (args: ProposeMutationArgs) => Promise<MutationProposal>;
  evalRun?: (args: {
    agent: string;
    tasks: EvalTask[];
    runsDir: string;
    runId: string;
    config: AgencyConfig;
    pipeAgentOutput: boolean;
  }) => Promise<EvalRunResult>;
  judgeSuite?: (args: JudgeSuiteArgs) => Promise<SuiteVerdict>;
};

type ChampionState = {
  iter: number | "baseline";
  files: Record<string, string>;
  targetSet: OptimizeTargetSet;
  evalRun: EvalRunResult;
};

export async function optimizeLoop(
  config: OptimizeLoopConfig,
  deps: OptimizeLoopDeps = {},
): Promise<OptimizeResult> {
  const { targetSet } = config.target;
  if (targetSet.targets.length === 0) {
    throw new Error(
      `No optimize targets found in the import tree of ${config.target.entryFile}. ` +
      "Mark declarations to optimize with the optimize modifier, for example: optimize const prompt = \"...\"",
    );
  }
  const tasks = normalizeOptimizeTasks(config.runtime.tasks, config.target.workingDir);
  const reporter = deps.reporter ?? SILENT_OPTIMIZE_REPORTER;

  const artifacts = createOptimizeArtifacts({
    runsDir: config.artifacts.runsDir,
    runId: config.artifacts.runId,
    workingDir: config.target.workingDir,
    entryFile: config.target.entryFile,
    node: config.target.node,
    tasksSource: config.runtime.tasksSource,
    iterations: config.policy.iterations,
    judgePolicy: config.judgePolicy,
    mutatorModel: config.policy.mutatorModel,
  });
  artifacts.writeTargets(targetSet);

  reporter.runStarted({ runId: config.artifacts.runId, targetSet, taskCount: tasks.length });
  const baselineFiles = sourceFileMap(targetSet);
  artifacts.writeIterationAgent(0, baselineFiles);
  const baselineEval = await runIterationEval(deps, config, artifacts, 0, baselineFiles, tasks);
  assertBaselineSucceeded(baselineEval);

  let champion: ChampionState = {
    iter: "baseline",
    files: baselineFiles,
    targetSet,
    evalRun: baselineEval,
  };
  const iterations: IterationResult[] = [{
    iter: 0,
    decision: "baseline",
    agentDir: path.join(artifacts.runDir, "iter-0", "agent"),
    evalRunDir: baselineEval.runDir,
    winsA: 0,
    winsB: 0,
    ties: 0,
  }];
  const history: MutationHistoryEntry[] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let validationFailedCount = 0;

  for (let iter = 1; iter <= config.policy.iterations; iter += 1) {
    const outcome = await runCandidateIteration({ iter, config, deps, reporter, artifacts, champion, history, tasks });
    iterations.push(outcome.iteration);
    history.push(outcome.historyEntry);
    if (outcome.newChampion) {
      acceptedCount += 1;
      champion = outcome.newChampion;
    } else if (outcome.iteration.decision === "validation-failed") {
      validationFailedCount += 1;
    } else {
      rejectedCount += 1;
    }
  }

  artifacts.writeFinalChampion(champion.files, champion.iter);
  const result: OptimizeResult = {
    runId: config.artifacts.runId,
    runDir: artifacts.runDir,
    championIter: champion.iter,
    championFiles: champion.files,
    acceptedCount,
    rejectedCount,
    validationFailedCount,
    iterations,
  };
  artifacts.writeSummary(result);
  const writebackApplied = writeBackIfRequested(config, champion);
  reporter.runFinished({
    result,
    writebackApplied,
    initialTargets: targetSet.targets,
    finalTargets: champion.targetSet.targets,
  });
  return result;
}

type IterationOutcome = {
  iteration: IterationResult;
  historyEntry: MutationHistoryEntry;
  /** Present iff the candidate was accepted. */
  newChampion?: ChampionState;
};

/** Runs one mutate → preview → eval → judge iteration against the champion. */
async function runCandidateIteration(args: {
  iter: number;
  config: OptimizeLoopConfig;
  deps: OptimizeLoopDeps;
  reporter: OptimizeReporter;
  artifacts: OptimizeArtifacts;
  champion: ChampionState;
  history: MutationHistoryEntry[];
  tasks: EvalTask[];
}): Promise<IterationOutcome> {
  const { iter, config, deps, reporter, artifacts, champion, history, tasks } = args;
  const total = config.policy.iterations;

  reporter.phase({ iter, total, message: "proposing mutation operations" });
  const mutation = await proposeValidMutation(config, deps, champion, history);
  if (!mutation.ok) {
    reporter.validationFailed({ iter, total, diagnostics: mutation.diagnostics });
    const mutationPath = artifacts.writeValidationFailure(iter, {
      rationale: mutation.rationale,
      diagnostics: mutation.diagnostics,
    });
    return {
      iteration: { iter, decision: "validation-failed", mutationPath, winsA: 0, winsB: 0, ties: 0 },
      historyEntry: {
        iter,
        decision: "validation-failed",
        winsA: 0,
        winsB: 0,
        rationale: mutation.rationale,
        operations: mutation.operations,
        lossReasons: mutation.diagnostics.map((diagnostic) => diagnostic.message),
      },
    };
  }

  const { preview, rationale } = mutation;
  const agentArtifact = artifacts.writeIterationAgent(iter, preview.files);
  const mutationArtifact = artifacts.writeMutationPreview(iter, preview, rationale);
  const operations = preview.changes.map((change) => ({ target: change.target, op: change.op }));

  const rejection = (phase: string, error: unknown): IterationOutcome => {
    reporter.iterationRejected({ iter, total, phase, error: errorMessage(error) });
    artifacts.writeRuntimeRejection(iter, error);
    return {
      iteration: {
        iter,
        decision: "rejected",
        agentDir: agentArtifact.agentDir,
        mutationPath: mutationArtifact.mutationMarkdownPath,
        winsA: 0,
        winsB: 0,
        ties: tasks.length,
      },
      historyEntry: {
        iter,
        decision: "rejected",
        winsA: 0,
        winsB: 0,
        rationale,
        operations,
        lossReasons: [errorMessage(error)],
      },
    };
  };

  let candidateEval: EvalRunResult;
  try {
    reporter.phase({ iter, total, message: "evaluating candidate" });
    candidateEval = await runIterationEval(deps, config, artifacts, iter, preview.files, tasks);
  } catch (error) {
    return rejection("eval", error);
  }

  let suiteVerdict: SuiteVerdict;
  try {
    reporter.phase({ iter, total, message: "judging candidate against champion" });
    suiteVerdict = await (deps.judgeSuite ?? judgeSuite)({
      runA: champion.evalRun,
      runB: candidateEval,
      tasks: config.runtime.tasks,
      policy: config.judgePolicy,
    });
  } catch (error) {
    return rejection("judging", error);
  }

  const verdictPath = artifacts.writeVerdict(iter, suiteVerdict);
  const accepted = suiteVerdict.winner === "B";
  const decision = accepted ? "accepted" : "rejected";
  reporter.iterationDecided({
    iter,
    total,
    decision,
    verdict: suiteVerdict,
    changes: preview.changes,
    rationale,
    records: pairTaskRecords(config.runtime.tasks, champion.evalRun, candidateEval),
  });
  return {
    iteration: {
      iter,
      decision,
      agentDir: agentArtifact.agentDir,
      mutationPath: mutationArtifact.mutationMarkdownPath,
      evalRunDir: candidateEval.runDir,
      verdictPath,
      winsA: suiteVerdict.winsA,
      winsB: suiteVerdict.winsB,
      ties: suiteVerdict.ties,
    },
    historyEntry: {
      iter,
      decision,
      winsA: suiteVerdict.winsA,
      winsB: suiteVerdict.winsB,
      rationale,
      operations,
      lossReasons: suiteVerdict.perTask
        .filter((task) => task.winner === "A")
        .map((task) => task.reasoning),
    },
    ...(accepted
      ? { newChampion: { iter, files: preview.files, targetSet: preview.targetSet, evalRun: candidateEval } }
      : {}),
  };
}

/** One initial proposal plus one retry with the rejected preview's
 *  diagnostics fed back to the mutator. */
const MUTATION_PROPOSAL_ATTEMPTS = 2;

/**
 * Each iteration's eval run lives inside its own `iter-N/` directory, so
 * the eval run id is a fixed directory name rather than an identifier:
 * `runsDir: iter-N` + `runId: "eval-run"` materializes `iter-N/eval-run/`.
 */
const EVAL_RUN_DIR_NAME = "eval-run";

type MutationOutcome =
  | { ok: true; preview: OptimizeMutationPreview; rationale: string }
  | {
    ok: false;
    rationale: string;
    diagnostics: OptimizeMutationDiagnostic[];
    operations: { target: string; op: string }[];
  };

/**
 * Asks the mutator for operations and validates them through the source
 * mutator. A rejected preview earns exactly one retry with the diagnostics
 * fed back; a second rejection becomes a validation-failed outcome.
 */
async function proposeValidMutation(
  config: OptimizeLoopConfig,
  deps: OptimizeLoopDeps,
  champion: ChampionState,
  history: MutationHistoryEntry[],
): Promise<MutationOutcome> {
  const sourceMutator = new OptimizeSourceMutator({ targetSet: champion.targetSet });
  let diagnostics: OptimizeMutationDiagnostic[] | undefined;
  let lastProposal: MutationProposal | null = null;

  for (let attempt = 0; attempt < MUTATION_PROPOSAL_ATTEMPTS; attempt += 1) {
    const proposal = await (deps.mutate ?? proposeMutation)({
      config: config.runtime.config,
      targets: champion.targetSet.targets,
      tasks: config.runtime.tasks,
      history: buildMutationHistory(history),
      model: config.policy.mutatorModel,
      ...(diagnostics ? { diagnostics } : {}),
    });
    lastProposal = proposal;
    const preview = sourceMutator.preview(proposal.operations);
    if (preview.diagnostics.length === 0) {
      return { ok: true, preview, rationale: proposal.rationale };
    }
    diagnostics = preview.diagnostics;
  }

  return {
    ok: false,
    rationale: lastProposal?.rationale ?? "",
    diagnostics: diagnostics ?? [],
    operations: (lastProposal?.operations ?? []).map((operation) => ({
      target: operation.target,
      op: operation.op,
    })),
  };
}

async function runIterationEval(
  deps: OptimizeLoopDeps,
  config: OptimizeLoopConfig,
  artifacts: OptimizeArtifacts,
  iter: number,
  files: Record<string, string>,
  tasks: EvalTask[],
): Promise<EvalRunResult> {
  const workspace = artifacts.writeIterationWorkspace(iter, files);
  return (deps.evalRun ?? defaultEvalRun)({
    agent: path.join(workspace.workspaceDir, config.target.entryFile),
    tasks,
    runsDir: path.join(artifacts.runDir, `iter-${iter}`),
    runId: EVAL_RUN_DIR_NAME,
    config: config.runtime.config,
    pipeAgentOutput: deps.pipeAgentOutput ?? false,
  });
}

async function defaultEvalRun(args: {
  agent: string;
  tasks: EvalTask[];
  runsDir: string;
  runId: string;
  config: AgencyConfig;
  pipeAgentOutput: boolean;
}): Promise<EvalRunResult> {
  return evalRunLoadedTasks({
    ...args,
    tasksSource: "optimize:tasks",
    continueOnError: true,
    quietCompile: true,
  });
}

/**
 * The baseline runs the unmutated program: any failure means the program
 * or the task suite is broken, so optimizing would be meaningless. Abort
 * with the failing tasks instead of continuing.
 */
function assertBaselineSucceeded(result: EvalRunResult): void {
  const failed = result.tasks.filter((task) => task.status === "error");
  if (failed.length === 0) return;
  const details = failed
    .map((task) => `- ${task.taskId}: ${task.errorMessage ?? "unknown error"}`)
    .join("\n");
  throw new Error(
    `Baseline eval failed before any mutation was made, so the program (or task suite) is broken — fix it before optimizing:\n${details}\nSee ${result.runDir} for artifacts.`,
  );
}

function pairTaskRecords(
  tasks: EvalTask[],
  championEval: EvalRunResult,
  candidateEval: EvalRunResult,
): TaskRecordPair[] {
  return tasks.map((task) => ({
    taskId: task.task_id,
    ...(recordPath(championEval, task.task_id) ? { championRecordPath: recordPath(championEval, task.task_id) } : {}),
    ...(recordPath(candidateEval, task.task_id) ? { candidateRecordPath: recordPath(candidateEval, task.task_id) } : {}),
  }));
}

function recordPath(result: EvalRunResult, taskId: string): string | undefined {
  const task = result.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task || task.status !== "success" || !task.evalRecordPath) return undefined;
  return task.evalRecordPath;
}

function sourceFileMap(targetSet: OptimizeTargetSet): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [file, sourceFile] of Object.entries(targetSet.files)) {
    files[file] = sourceFile.source;
  }
  return files;
}

/**
 * Writes the champion file set back to the original source paths. Every
 * file's current on-disk content must still match its discovery-time
 * sha256 — one mismatch aborts the entire writeback (artifacts are already
 * written by this point, so nothing is lost).
 */
function writeBackIfRequested(config: OptimizeLoopConfig, champion: ChampionState): boolean {
  if (!config.target.writeback || champion.iter === "baseline") return false;
  const discovered = config.target.targetSet.files;

  for (const sourceFile of Object.values(discovered)) {
    const currentSha = sha256Text(fs.readFileSync(sourceFile.absoluteFile, "utf8"));
    if (currentSha !== sourceFile.sha256) {
      throw new Error(`Source file ${sourceFile.absoluteFile} was modified externally; writeback aborted.`);
    }
  }
  for (const [file, source] of Object.entries(champion.files)) {
    if (source === discovered[file].source) continue;
    fs.writeFileSync(discovered[file].absoluteFile, source);
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
