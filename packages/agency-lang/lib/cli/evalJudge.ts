import * as fs from "fs";
import * as path from "path";

import { judgePairwise } from "@/eval/judge/pairwise.js";

export type EvalJudgeOptions = {
  goal: string;
  out?: string;
};

export async function evalJudge(
  recordPathA: string,
  recordPathB: string,
  opts: EvalJudgeOptions,
): Promise<void> {
  const verdict = await judgePairwise(opts.goal, recordPathA, recordPathB);
  const outPath = opts.out ?? defaultOutPath(recordPathA, recordPathB);
  fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2));

  console.log(`Winner: ${verdict.winner} (${verdict.confidence})`);
  console.log(`Reasoning: ${verdict.reasoning}`);
  console.log(`\nWrote verdict to ${outPath}`);
}

function defaultOutPath(recordPathA: string, recordPathB: string): string {
  return `${stem(recordPathA)}.vs.${stem(recordPathB)}.verdict.json`;
}

function stem(filePath: string): string {
  return path.basename(filePath).replace(/\.eval\.json$/, "");
}
