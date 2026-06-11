import * as fs from "fs";

import { runAgencyAgent } from "@/cli/runAgencyAgent.js";
import type { JudgeSample, JudgeWinner, PairwiseJudgeResult, PairwiseVerdict, TaskVerdict } from "./types.js";
import { selectFinalResponse } from "./selectFinalResponse.js";

export type JudgePairwiseOptions = {
  baseName?: string;
};

export type JudgePairArgs = JudgePairwiseOptions & {
  taskId?: string;
  goal: string;
  recordPathA: string;
  recordPathB: string;
  order?: "AB" | "BA";
};

export async function judgePair(args: JudgePairArgs): Promise<TaskVerdict> {
  const order = args.order ?? "AB";
  const recordA = readJson(args.recordPathA);
  const recordB = readJson(args.recordPathB);
  const respA = selectFinalResponse(recordA);
  const respB = selectFinalResponse(recordB);

  if (respA.missing) warnMissing(args.recordPathA);
  if (respB.missing) warnMissing(args.recordPathB);

  const judged = await runPairwiseJudge(
    args.goal,
    order === "AB" ? respA.text : respB.text,
    order === "AB" ? respB.text : respA.text,
  );
  const sample: JudgeSample = {
    winner: mapWinnerToOriginal(judged.winner, order),
    confidence: judged.confidence,
    reasoning: judged.reasoning,
    order,
  };

  return {
    taskId: args.taskId ?? "task-1",
    goal: args.goal,
    inputs: [
      taskInputOf(args.recordPathA, respA),
      taskInputOf(args.recordPathB, respB),
    ],
    winner: sample.winner,
    confidence: sample.confidence,
    reasoning: sample.reasoning,
    samples: [sample],
    generatedAt: new Date().toISOString(),
  };
}

export async function judgePairwise(
  goal: string,
  recordPathA: string,
  recordPathB: string,
  opts: JudgePairwiseOptions = {},
): Promise<PairwiseVerdict> {
  const verdict = await judgePair({ goal, recordPathA, recordPathB, ...opts });

  return {
    verdictVersion: 1,
    goal,
    inputs: verdict.inputs.map((input) => ({
      path: input.path ?? "",
      response: input.response ?? null,
      ...(input.truncated ? { truncated: true as const } : {}),
    })) as PairwiseVerdict["inputs"],
    winner: verdict.winner,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    generatedAt: verdict.generatedAt,
  };
}

async function runPairwiseJudge(
  goal: string,
  responseA: string,
  responseB: string,
): Promise<PairwiseJudgeResult> {
  const result = await runAgencyAgent({
    agent: "judgePairwise.agency",
    node: "judgePairwise",
    args: { goal, responseA, responseB },
    config: {},
  });
  return assertPairwiseJudgeResult(result.data);
}

function assertPairwiseJudgeResult(value: unknown): PairwiseJudgeResult {
  if (!value || typeof value !== "object") {
    throw new Error("Malformed pairwise judge result: expected object");
  }
  const result = value as Record<string, unknown>;
  if (result.winner !== "A" && result.winner !== "B" && result.winner !== "tie") {
    throw new Error("Malformed pairwise judge result: winner must be A, B, or tie");
  }
  if (typeof result.confidence !== "number") {
    throw new Error("Malformed pairwise judge result: confidence must be a number");
  }
  if (typeof result.reasoning !== "string") {
    throw new Error("Malformed pairwise judge result: reasoning must be a string");
  }
  return {
    winner: result.winner,
    confidence: result.confidence,
    reasoning: result.reasoning,
  };
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Eval record not found: ${filePath}`);
    }
    throw error;
  }
}

function warnMissing(filePath: string): void {
  process.stderr.write(
    `warning: ${filePath} has no recorded final response; judging against empty string.\n`,
  );
}

function inputOf(
  filePath: string,
  response: { text: string; missing: boolean; truncated?: true },
): { path: string; response: string | null; truncated?: true } {
  return {
    path: filePath,
    response: response.missing ? null : response.text,
    ...(response.truncated ? { truncated: true as const } : {}),
  };
}

function taskInputOf(
  filePath: string,
  response: { text: string; missing: boolean; truncated?: true },
): TaskVerdict["inputs"][number] {
  return {
    ...inputOf(filePath, response),
    status: "ok",
  };
}

function mapWinnerToOriginal(winner: JudgeWinner, order: "AB" | "BA"): JudgeWinner {
  if (winner === "tie" || order === "AB") return winner;
  return winner === "A" ? "B" : "A";
}
