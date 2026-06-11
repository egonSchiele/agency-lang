import * as fs from "fs";
import * as path from "path";

import { judgePairwise } from "@/eval/judge/pairwise.js";
import { judgeSuite } from "@/eval/judge/suite.js";
import { loadTasks, taskFromGoal } from "@/eval/loadTasks.js";
import { readEvalRun } from "@/eval/readRun.js";
import type { JudgeAggregationPolicy } from "@/eval/judge/types.js";

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
  if (Object.keys(summaryA.tasksById).length > 1 || Object.keys(summaryB.tasksById).length > 1) {
    throw new Error("--goal is ambiguous for multi-task run directories; use --tasks instead");
  }
  return [taskFromGoal(goal)];
}

function policyFromOptions(opts: EvalJudgeOptions): JudgeAggregationPolicy {
  return {
    samples: opts.samples ?? 3,
    confidenceThreshold: opts.confidenceThreshold ?? 50,
    marginThreshold: opts.marginThreshold ?? 0,
    positionBias: opts.positionBias ?? "swap",
  };
}

function defaultOutPath(recordPathA: string, recordPathB: string): string {
  return `${stem(recordPathA)}.vs.${stem(recordPathB)}.verdict.json`;
}

function stem(filePath: string): string {
  return path.basename(filePath).replace(/\.eval\.json$/, "");
}
