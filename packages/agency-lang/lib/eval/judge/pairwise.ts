import * as fs from "fs";

import { runAgencyAgent } from "@/cli/runAgencyAgent.js";
import type { JudgeSample, JudgeWinner, PairwiseJudgeResult, PairwiseVerdict, TaskVerdict } from "./types.js";
import { selectFinalResponse } from "./selectFinalResponse.js";
import { z } from "zod";

const PairwiseJudgeResultSchema = z.object({
  winner: z.union([z.literal("A"), z.literal("B"), z.literal("tie")]),
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string(),
});

export type JudgePairArgs = {
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
): Promise<PairwiseVerdict> {
  const verdict = await judgePair({ goal, recordPathA, recordPathB });

  return {
    verdictVersion: 1,
    goal,
    inputs: [
      pairwiseInputOf(verdict.inputs[0]),
      pairwiseInputOf(verdict.inputs[1]),
    ],
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
  const parsed = PairwiseJudgeResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Malformed pairwise judge result: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
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

function pairwiseInputOf(input: TaskVerdict["inputs"][number]): PairwiseVerdict["inputs"][number] {
  return {
    path: input.path ?? "",
    response: input.response ?? null,
    ...(input.truncated ? { truncated: true as const } : {}),
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
