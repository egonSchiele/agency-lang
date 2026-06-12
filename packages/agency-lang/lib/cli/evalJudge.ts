import * as fs from "fs";
import * as path from "path";

import { judgePairwise } from "@/eval/judge/pairwise.js";
import { judgeSuite } from "@/eval/judge/suite.js";
import { loadTasks } from "@/eval/loadTasks.js";
import { readEvalRun, type ReadEvalRunResult } from "@/eval/readRun.js";
import type { JudgeAggregationPolicy } from "@/eval/judge/types.js";
import type { EvalTask } from "@/eval/runTypes.js";

export type EvalJudgeOptions = {
  goal?: string;
  tasks?: string;
  out?: string;
  samples?: number;
  confidenceThreshold?: number;
  marginThreshold?: number;
  positionBias?: "swap" | "none";
};

export async function evalJudge(
  inputA: string,
  inputB: string,
  opts: EvalJudgeOptions,
): Promise<void> {
  const mode = inputMode(inputA, inputB);
  if (mode === "mixed") {
    throw new Error("Both inputs to eval judge must be files or both must be run directories");
  }

  if (mode === "files") {
    if (!opts.goal) throw new Error("--goal is required when judging eval record files");
    if (opts.tasks) throw new Error("--tasks is only supported for run-directory comparison");
    const verdict = await judgePairwise(opts.goal, inputA, inputB);
    const outPath = opts.out ?? defaultOutPath(inputA, inputB);
    fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2));

    console.log(`Winner: ${verdict.winner} (${verdict.confidence})`);
    console.log(`Reasoning: ${verdict.reasoning}`);
    console.log(`\nWrote verdict to ${outPath}`);
    return;
  }

  const taskSelection = validateTaskSelection(opts);
  const tasks = taskSelection === "goal" ? tasksFromInlineGoal(inputA, inputB, opts.goal ?? "") : loadTasks(path.resolve(opts.tasks ?? ""));
  const verdict = await judgeSuite({
    runA: inputA,
    runB: inputB,
    tasks,
    policy: policyFromOptions(opts),
  });
  const outPath = opts.out ?? defaultOutPath(inputA, inputB);
  fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2));

  console.log(`Suite winner: ${verdict.winner} (A ${verdict.winsA}, B ${verdict.winsB}, ties ${verdict.ties})`);
  console.log(`\nWrote verdict to ${outPath}`);
}

function inputMode(inputA: string, inputB: string): "files" | "dirs" | "mixed" {
  const aDir = fs.existsSync(inputA) && fs.statSync(inputA).isDirectory();
  const bDir = fs.existsSync(inputB) && fs.statSync(inputB).isDirectory();
  if (aDir && bDir) return "dirs";
  if (!aDir && !bDir) return "files";
  return "mixed";
}

function validateTaskSelection(opts: EvalJudgeOptions): "tasks" | "goal" {
  const count = (opts.tasks ? 1 : 0) + (opts.goal ? 1 : 0);
  if (count !== 1) {
    throw new Error("Provide exactly one of --tasks or --goal");
  }
  return opts.goal ? "goal" : "tasks";
}

function tasksFromInlineGoal(runA: string, runB: string, goal: string) {
  const summaryA = readEvalRun(runA);
  const summaryB = readEvalRun(runB);
  const taskIdA = onlyTaskId(summaryA);
  const taskIdB = onlyTaskId(summaryB);
  if (taskIdA !== taskIdB) {
    throw new Error(`Inline --goal run task ids differ (${taskIdA} vs ${taskIdB}); use --tasks instead`);
  }
  return [{ task_id: taskIdA, goal, args: {} }];
}

function policyFromOptions(opts: EvalJudgeOptions): JudgeAggregationPolicy {
  return {
    samples: integerOption("samples", opts.samples ?? 3, { min: 1 }),
    confidenceThreshold: integerOption("confidenceThreshold", opts.confidenceThreshold ?? 50, { min: 0, max: 100 }),
    marginThreshold: integerOption("marginThreshold", opts.marginThreshold ?? 0, { min: 0 }),
    positionBias: opts.positionBias ?? "swap",
  };
}

function onlyTaskId(run: ReadEvalRunResult): EvalTask["task_id"] {
  const taskIds = Object.keys(run.tasksById);
  if (taskIds.length !== 1) {
    throw new Error("--goal is ambiguous for multi-task run directories; use --tasks instead");
  }
  const taskId = taskIds[0];
  if (!taskId) throw new Error("--goal requires run directories with one task; use --tasks instead");
  return taskId;
}

function integerOption(
  name: string,
  value: number,
  bounds: { min?: number; max?: number },
): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be a finite integer`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(`${name} must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(`${name} must be <= ${bounds.max}`);
  }
  return value;
}

function defaultOutPath(recordPathA: string, recordPathB: string): string {
  return `${stem(recordPathA)}.vs.${stem(recordPathB)}.verdict.json`;
}

function stem(filePath: string): string {
  return path.basename(filePath).replace(/\.eval\.json$/, "");
}
