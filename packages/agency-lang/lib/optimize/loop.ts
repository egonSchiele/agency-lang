import * as fs from "fs";
import * as path from "path";

import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import { evalRunLoadedTasks } from "@/cli/eval/run.js";
import type { AgencyConfig } from "@/config.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import type { EvalRunResult, EvalRunTask } from "@/eval/runTypes.js";
import { parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";

import { findOptimizeTargets, getPromptValue, updatePrompt } from "./ast.js";
import { createOptimizeArtifacts, sha256Text } from "./artifacts.js";
import { buildMutationHistory, type MutationHistoryEntry } from "./history.js";
import { proposeMutation, type MutatorModelCaller } from "./mutator.js";
import { judgeCandidateAgainstChampion } from "./sampling.js";
import { normalizeOptimizeTasks } from "./tasks.js";
import type {
  IterationResult,
  MutationProposal,
  OptimizeLoopConfig,
  OptimizeResult,
  OptimizeTaskVerdict,
} from "./types.js";
import { validateMutationPrompt } from "./validation.js";
import { buildOptimizeVerdict } from "./verdict.js";

export type OptimizeLoopDeps = {
  report?: (message: string) => void;
  mutate?: (args: {
    config: AgencyConfig;
    goal: string;
    currentPrompt: string;
    history: string;
    model?: string;
    validationFailure?: string;
    callModel?: MutatorModelCaller;
  }) => Promise<MutationProposal>;
  evalRun?: (args: {
    agent: string;
    tasks: EvalRunTask[];
    runsDir: string;
    runId: string;
    config: AgencyConfig;
  }) => Promise<EvalRunResult>;
  judgeTask?: (args: {
    taskId: string;
    rubric: string;
    championRecordPath: string;
    candidateRecordPath: string;
    samples: number;
  }) => Promise<OptimizeTaskVerdict>;
};

type ChampionState = {
  iter: number | "baseline";
  source: string;
  agentPath: string;
  evalRun: EvalRunResult;
};

export async function optimizeLoop(
  config: OptimizeLoopConfig,
  deps: OptimizeLoopDeps = {},
): Promise<OptimizeResult> {
  validateOptimizeTarget(config.agentSource, config.node);
  const normalizedTasks = normalizeOptimizeTasks(config.tasks, config.workingDir);
  report(deps, `Run ${config.runId}: writing baseline artifacts`);
  const artifacts = createOptimizeArtifacts({
    runsDir: config.runsDir,
    runId: config.runId,
    agentFilename: config.agentFilename,
    workingDir: config.workingDir,
    goal: config.goal,
    iterations: config.iterations,
    judgeSamples: config.judgeSamples,
    acceptThreshold: config.acceptThreshold,
    mutatorModel: config.mutatorModel,
    sourceSha256: sha256Text(config.agentSource),
  });
  const baselineArtifact = artifacts.writeBaseline(config.agentSource);
  report(deps, `Evaluating baseline on ${normalizedTasks.length} task(s)`);
  const baselineEval = await runEval(deps, config, baselineArtifact.workspaceAgentPath, normalizedTasks, "iter-0", path.join(baselineArtifact.iterDir, "eval-run"));
  let champion: ChampionState = {
    iter: "baseline",
    source: config.agentSource,
    agentPath: baselineArtifact.agentPath,
    evalRun: baselineEval,
  };
  const iterations: IterationResult[] = [{
    iter: 0,
    agentPath: baselineArtifact.agentPath,
    evalRunDir: baselineEval.runDir,
    decision: "baseline",
    wins: 0,
    losses: 0,
    ties: 0,
  }];
  const history: MutationHistoryEntry[] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let validationFailedCount = 0;

  for (let iter = 1; iter <= config.iterations; iter += 1) {
    report(deps, `Iteration ${iter}/${config.iterations}: proposing prompt mutation`);
    const currentSource = fs.readFileSync(champion.agentPath, "utf-8");
    const currentPrompt = promptFromSource(currentSource, config.node);
    const mutation = await proposeValidMutation(config, deps, currentPrompt, buildMutationHistory(history));
    if (!mutation.ok) {
      report(deps, `Iteration ${iter}/${config.iterations}: validation failed (${mutation.error})`);
      const failure = artifacts.writeValidationFailure(iter, mutation);
      validationFailedCount += 1;
      const iteration = iterationFromArtifact(iter, failure, "validation-failed", 0, 0, 0);
      iterations.push(iteration);
      history.push({ iter, decision: "validation-failed", wins: 0, losses: 0, rationale: mutation.rationale ?? mutation.error, lossReasons: [] });
      continue;
    }

    const candidateSource = updateSourcePrompt(currentSource, config.node, mutation.prompt);
    const candidateArtifact = artifacts.writeCandidate(iter, candidateSource, { rationale: mutation.rationale });
    let candidateEval: EvalRunResult;
    try {
      report(deps, `Iteration ${iter}/${config.iterations}: evaluating candidate`);
      candidateEval = await runEval(deps, config, candidateArtifact.workspaceAgentPath, normalizedTasks, `iter-${iter}`, path.join(candidateArtifact.iterDir, "eval-run"));
      assertEvalRecords(candidateEval);
      assertEvalRecords(champion.evalRun);
    } catch (error) {
      report(deps, `Iteration ${iter}/${config.iterations}: rejected during eval (${errorText(error)})`);
      artifacts.writeRuntimeRejection(iter, error);
      rejectedCount += 1;
      const iteration = iterationFromArtifact(iter, candidateArtifact, "rejected", 0, 0, normalizedTasks.length);
      iterations.push(iteration);
      history.push({ iter, decision: "rejected", wins: 0, losses: 0, rationale: mutation.rationale, lossReasons: [errorText(error)] });
      continue;
    }

    let perTask: OptimizeTaskVerdict[];
    try {
      report(deps, `Iteration ${iter}/${config.iterations}: judging candidate against champion`);
      perTask = await judgeTasks(deps, normalizedTasks, champion.evalRun, candidateEval, config.judgeSamples);
    } catch (error) {
      report(deps, `Iteration ${iter}/${config.iterations}: rejected during judging (${errorText(error)})`);
      artifacts.writeRuntimeRejection(iter, error);
      rejectedCount += 1;
      const iteration = iterationFromArtifact(iter, candidateArtifact, "rejected", 0, 0, normalizedTasks.length);
      iterations.push(iteration);
      history.push({ iter, decision: "rejected", wins: 0, losses: 0, rationale: mutation.rationale, lossReasons: [errorText(error)] });
      continue;
    }

    const verdict = buildOptimizeVerdict({
      iter,
      championIter: champion.iter,
      judgeSamples: config.judgeSamples,
      acceptThreshold: config.acceptThreshold,
      perTask,
      mutationSummary: mutation.rationale,
    });
    const verdictPath = artifacts.writeVerdict(iter, verdict);
    const iteration = iterationFromArtifact(iter, candidateArtifact, verdict.decision, verdict.wins, verdict.losses, verdict.ties, candidateEval.runDir, verdictPath);
    iterations.push(iteration);
    report(deps, `Iteration ${iter}/${config.iterations}: ${verdict.decision} (wins ${verdict.wins}, losses ${verdict.losses}, ties ${verdict.ties})`);
    history.push({
      iter,
      decision: verdict.decision,
      wins: verdict.wins,
      losses: verdict.losses,
      rationale: mutation.rationale,
      lossReasons: perTask.filter((task) => task.winner === "champion").map((task) => task.samples[0]?.reasoning ?? "candidate lost"),
    });
    if (verdict.decision === "accepted") {
      acceptedCount += 1;
      champion = { iter, source: candidateSource, agentPath: candidateArtifact.agentPath, evalRun: candidateEval };
    } else {
      rejectedCount += 1;
    }
  }

  report(deps, "Writing final champion and summary");
  artifacts.writeFinalChampion(champion.source, champion.iter);
  const result: OptimizeResult = {
    runId: config.runId,
    runDir: artifacts.runDir,
    championIter: champion.iter,
    championSource: champion.source,
    acceptedCount,
    rejectedCount,
    validationFailedCount,
    iterations,
  };
  artifacts.writeSummary(result);
  writeBackIfRequested(config, result);
  report(deps, `Complete: champion iteration ${champion.iter}, accepted ${acceptedCount}, rejected ${rejectedCount}, validation failed ${validationFailedCount}`);
  return result;
}

function report(deps: OptimizeLoopDeps, message: string): void {
  deps.report?.(`[optimize] ${message}`);
}

async function proposeValidMutation(
  config: OptimizeLoopConfig,
  deps: OptimizeLoopDeps,
  currentPrompt: string,
  history: string,
): Promise<MutationProposal & { ok: true } | { ok: false; attemptedPrompt: string; rationale?: string; error: string }> {
  let validationFailure: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const proposal = await (deps.mutate ?? proposeMutation)({
      config: config.config,
      goal: config.goal,
      currentPrompt,
      history,
      model: config.mutatorModel,
      validationFailure,
    });
    const validation = validateMutationPrompt(currentPrompt, proposal.prompt);
    if (validation.ok) return { ...proposal, ok: true };
    validationFailure = validation.reason;
    if (attempt === 1) {
      return { ok: false, attemptedPrompt: proposal.prompt, rationale: proposal.rationale, error: validation.reason };
    }
  }
  return { ok: false, attemptedPrompt: "", error: "validation failed" };
}

async function runEval(
  deps: OptimizeLoopDeps,
  config: OptimizeLoopConfig,
  agent: string,
  tasks: EvalRunTask[],
  runId: string,
  runsDir: string,
): Promise<EvalRunResult> {
  return (deps.evalRun ?? defaultEvalRun)({ agent, tasks, runsDir, runId, config: config.config });
}

async function defaultEvalRun(args: {
  agent: string;
  tasks: EvalRunTask[];
  runsDir: string;
  runId: string;
  config: AgencyConfig;
}): Promise<EvalRunResult> {
  return evalRunLoadedTasks({
    agent: args.agent,
    tasks: args.tasks,
    tasksSource: "optimize:tasks",
    runsDir: args.runsDir,
    runId: args.runId,
    continueOnError: true,
    config: args.config,
  });
}

async function judgeTasks(
  deps: OptimizeLoopDeps,
  tasks: EvalRunTask[],
  championEval: EvalRunResult,
  candidateEval: EvalRunResult,
  samples: number,
): Promise<OptimizeTaskVerdict[]> {
  const results: OptimizeTaskVerdict[] = [];
  for (const task of tasks) {
    const championRecordPath = recordPathForTask(championEval, task.task_id);
    const candidateRecordPath = recordPathForTask(candidateEval, task.task_id);
    results.push(await (deps.judgeTask ?? judgeCandidateAgainstChampion)({
      taskId: task.task_id,
      rubric: task.rubric,
      championRecordPath,
      candidateRecordPath,
      samples,
    }));
  }
  return results;
}

function validateOptimizeTarget(source: string, nodeName: string): void {
  const targets = targetsFromSource(source, nodeName);
  if (targets.length === 0) throw new Error(`No @optimize(prompt) tag found in node "${nodeName}"`);
  if (targets.length > 1) throw new Error(`Multiple @optimize targets found in node "${nodeName}"`);
  const [target] = targets;
  if (!target.configKeys?.includes("prompt")) throw new Error("@optimize target must include prompt");
  if (target.llmCall === null) throw new Error("@optimize(prompt) target must contain an llm(...) call");
}

function promptFromSource(source: string, nodeName: string): string {
  return getPromptValue(targetsFromSource(source, nodeName)[0]);
}

function updateSourcePrompt(source: string, nodeName: string, prompt: string): string {
  const program = programFromSource(source);
  const target = findOptimizeTargets(program, nodeName)[0];
  updatePrompt(target, prompt);
  return new AgencyGenerator().generate(program).output;
}

function targetsFromSource(source: string, nodeName: string) {
  return findOptimizeTargets(programFromSource(source), nodeName);
}

function programFromSource(source: string) {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`Parse error: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result);
  const preprocessor = new TypescriptPreprocessor(parsed.result, {}, info);
  return preprocessor.preprocess();
}

function iterationFromArtifact(
  iter: number,
  artifact: { agentPath: string; mutationPath?: string },
  decision: IterationResult["decision"],
  wins: number,
  losses: number,
  ties: number,
  evalRunDir?: string,
  verdictPath?: string,
): IterationResult {
  return {
    iter,
    agentPath: artifact.agentPath,
    mutationPath: artifact.mutationPath,
    evalRunDir,
    verdictPath,
    decision,
    wins,
    losses,
    ties,
  };
}

function assertEvalRecords(result: EvalRunResult): void {
  for (const task of result.tasks) {
    if (!task.evalRecordPath || !fs.existsSync(task.evalRecordPath)) {
      throw new Error(`Missing eval record for task ${task.taskId}`);
    }
  }
}

function recordPathForTask(result: EvalRunResult, taskId: string): string {
  const task = result.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task || !task.evalRecordPath || !fs.existsSync(task.evalRecordPath)) {
    throw new Error(`Missing eval record for task ${taskId}`);
  }
  return task.evalRecordPath;
}

function writeBackIfRequested(config: OptimizeLoopConfig, result: OptimizeResult): void {
  if (!config.writebackPath || result.championIter === "baseline") return;
  const currentSource = fs.readFileSync(config.writebackPath, "utf-8");
  if (sha256Text(currentSource) !== sha256Text(config.agentSource)) {
    throw new Error(`Source file ${config.writebackPath} was modified externally; writeback aborted.`);
  }
  fs.writeFileSync(config.writebackPath, result.championSource);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
