import * as fs from "fs";

import { runAgencyAgent } from "@/cli/runAgencyAgent.js";
import type { PairwiseJudgeResult, PairwiseVerdict } from "./types.js";
import { selectFinalResponse } from "./selectFinalResponse.js";

export type JudgePairwiseOptions = {
  baseName?: string;
};

export async function judgePairwise(
  goal: string,
  recordPathA: string,
  recordPathB: string,
  _opts: JudgePairwiseOptions = {},
): Promise<PairwiseVerdict> {
  const recordA = readJson(recordPathA);
  const recordB = readJson(recordPathB);
  const respA = selectFinalResponse(recordA);
  const respB = selectFinalResponse(recordB);

  if (respA.missing) warnMissing(recordPathA);
  if (respB.missing) warnMissing(recordPathB);

  const judged = await runPairwiseJudge(goal, respA.text, respB.text);

  return {
    verdictVersion: 1,
    goal,
    inputs: [
      inputOf(recordPathA, respA),
      inputOf(recordPathB, respB),
    ],
    winner: judged.winner,
    confidence: judged.confidence,
    reasoning: judged.reasoning,
    generatedAt: new Date().toISOString(),
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
