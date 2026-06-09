import * as fs from "fs";

import { executeJudgePairwiseAsync } from "@/cli/util.js";
import type { PairwiseVerdict } from "./types.js";
import { selectFinalResponse } from "./selectFinalResponse.js";

export type JudgePairwiseOptions = {
  baseName?: string;
};

export async function judgePairwise(
  goal: string,
  recordPathA: string,
  recordPathB: string,
  opts: JudgePairwiseOptions = {},
): Promise<PairwiseVerdict> {
  const recordA = readJson(recordPathA);
  const recordB = readJson(recordPathB);
  const respA = selectFinalResponse(recordA);
  const respB = selectFinalResponse(recordB);

  if (respA.missing) warnMissing(recordPathA);
  if (respB.missing) warnMissing(recordPathB);

  const judged = await executeJudgePairwiseAsync({
    baseName: opts.baseName ?? recordPathA.replace(/\.eval\.json$/, ""),
    goal,
    responseA: respA.text,
    responseB: respB.text,
  });

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
