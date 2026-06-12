import type {
  EvalRunResult,
  EvalTask,
} from "../runTypes.js";
import { readEvalRun, type ReadEvalRunResult, type ReadEvalRunTask } from "../readRun.js";
import { judgePair, type JudgePairArgs } from "./pairwise.js";
import type {
  JudgeAggregationPolicy,
  JudgeSample,
  JudgeWinner,
  SuiteVerdict,
  TaskVerdict,
} from "./types.js";

export type JudgeSuiteArgs = {
  runA: EvalRunResult | ReadEvalRunResult | string;
  runB: EvalRunResult | ReadEvalRunResult | string;
  tasks: EvalTask[];
  policy: JudgeAggregationPolicy;
  judgePair?: (args: JudgePairArgs) => Promise<TaskVerdict>;
};

export function orderForSample(index: number, positionBias: "swap" | "none"): "AB" | "BA" {
  if (positionBias === "none") return "AB";
  return index % 2 === 0 ? "AB" : "BA";
}

export function mapWinnerToOriginal(winner: JudgeWinner, order: "AB" | "BA"): JudgeWinner {
  if (winner === "tie" || order === "AB") return winner;
  return winner === "A" ? "B" : "A";
}

export function reduceSamples(args: {
  taskId: string;
  goal: string;
  samples: JudgeSample[];
  inputs: TaskVerdict["inputs"];
}): TaskVerdict {
  const mappedSamples = args.samples.map((sample) => ({
    ...sample,
    winner: mapWinnerToOriginal(sample.winner, sample.order),
  }));
  return {
    taskId: args.taskId,
    goal: args.goal,
    inputs: args.inputs,
    winner: winnerFromCounts(mappedSamples),
    confidence: mean(mappedSamples.map((sample) => sample.confidence)),
    reasoning: mappedSamples.map((sample) => sample.reasoning).join("\n"),
    samples: mappedSamples,
    generatedAt: new Date().toISOString(),
  };
}

export function aggregateSuite(perTask: TaskVerdict[], policy: JudgeAggregationPolicy): SuiteVerdict {
  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (const task of perTask) {
    const countedWinner = task.confidence < policy.confidenceThreshold ? "tie" : task.winner;
    if (countedWinner === "A") {
      winsA += 1;
    } else if (countedWinner === "B") {
      winsB += 1;
    } else {
      ties += 1;
    }
  }

  return {
    verdictVersion: 2,
    generatedAt: new Date().toISOString(),
    policy,
    winsA,
    winsB,
    ties,
    winner: suiteWinner(winsA, winsB, policy.marginThreshold),
    perTask,
  };
}

export async function judgeSuite(args: JudgeSuiteArgs): Promise<SuiteVerdict> {
  const runA = coerceRun(args.runA);
  const runB = coerceRun(args.runB);
  const perTask: TaskVerdict[] = [];
  const judge = args.judgePair ?? judgePair;

  for (const task of args.tasks) {
    const taskA = runA.tasksById[task.task_id] ?? missingTask(task.task_id);
    const taskB = runB.tasksById[task.task_id] ?? missingTask(task.task_id);
    if (taskA.status !== "ok" || taskB.status !== "ok") {
      perTask.push(missingDataVerdict(task, taskA, taskB));
      continue;
    }

    const samples: JudgeSample[] = [];
    for (let index = 0; index < args.policy.samples; index += 1) {
      const order = orderForSample(index, args.policy.positionBias);
      const verdict = await judge({
        taskId: task.task_id,
        goal: task.goal,
        recordPathA: taskA.recordPath ?? "",
        recordPathB: taskB.recordPath ?? "",
        order,
      });
      samples.push(...verdict.samples);
    }
    perTask.push(reduceSamples({
      taskId: task.task_id,
      goal: task.goal,
      samples,
      inputs: [inputFromTask(taskA), inputFromTask(taskB)],
    }));
  }

  return aggregateSuite(perTask, args.policy);
}

function winnerFromCounts(samples: JudgeSample[]): JudgeWinner {
  const winsA = samples.filter((sample) => sample.winner === "A").length;
  const winsB = samples.filter((sample) => sample.winner === "B").length;
  if (winsA > winsB) return "A";
  if (winsB > winsA) return "B";
  return "tie";
}

function suiteWinner(winsA: number, winsB: number, marginThreshold: number): JudgeWinner {
  const margin = Math.abs(winsA - winsB);
  if (margin <= marginThreshold) return "tie";
  return winsA > winsB ? "A" : "B";
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function coerceRun(run: EvalRunResult | ReadEvalRunResult | string): ReadEvalRunResult {
  if (typeof run === "string") return readEvalRun(run);
  if ("tasksById" in run) return run;
  const tasksById: Record<string, ReadEvalRunTask> = {};
  for (const task of run.tasks) {
    tasksById[task.taskId] = {
      taskId: task.taskId,
      recordPath: task.evalRecordPath,
      status: task.status === "success" ? "ok" : "failed",
      ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
    };
  }
  return { runDir: run.runDir, tasksById };
}

function missingTask(taskId: string): ReadEvalRunTask {
  return { taskId, status: "missing" };
}

function missingDataVerdict(task: EvalTask, taskA: ReadEvalRunTask, taskB: ReadEvalRunTask): TaskVerdict {
  const winner = missingDataWinner(taskA.status, taskB.status);
  return {
    taskId: task.task_id,
    goal: task.goal,
    inputs: [inputFromTask(taskA), inputFromTask(taskB)],
    winner,
    confidence: 100,
    reasoning: `A status: ${taskA.status}; B status: ${taskB.status}`,
    samples: [{ winner, confidence: 100, reasoning: "deterministic missing-data verdict", order: "AB" }],
    generatedAt: new Date().toISOString(),
  };
}

function missingDataWinner(statusA: ReadEvalRunTask["status"], statusB: ReadEvalRunTask["status"]): JudgeWinner {
  if (statusA === "ok" && statusB !== "ok") return "A";
  if (statusB === "ok" && statusA !== "ok") return "B";
  return "tie";
}

function inputFromTask(task: ReadEvalRunTask): TaskVerdict["inputs"][number] {
  return {
    ...(task.recordPath ? { path: task.recordPath } : {}),
    status: task.status,
    ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
  };
}
