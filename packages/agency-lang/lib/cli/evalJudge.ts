import * as fs from "fs";
import * as path from "path";

import { judgePairwise } from "@/eval/judge/pairwise.js";
import { judgeSuite } from "@/eval/judge/suite.js";
import type { JudgeAggregationPolicy } from "@/eval/judge/types.js";

export type EvalJudgeOptions = {
  /** Statelog-file mode only — run directories carry their own goals. */
  goal?: string;
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
    throw new Error(
      "Both inputs to eval judge must be statelog files or both must be run directories",
    );
  }

  if (mode === "files") {
    if (!opts.goal) throw new Error("--goal is required when judging statelog files");
    const verdict = await judgePairwise(opts.goal, inputA, inputB);
    const outPath = opts.out ?? defaultOutPath(inputA, inputB);
    fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2));

    console.log(`Winner: ${verdict.winner} (${verdict.confidence})`);
    console.log(`Reasoning: ${verdict.reasoning}`);
    console.log(`\nWrote verdict to ${outPath}`);
    return;
  }

  if (opts.goal) {
    throw new Error(
      "--goal is only for judging statelog files; run directories carry their own goals on each test's run row",
    );
  }
  const verdict = await judgeSuite({
    runA: inputA,
    runB: inputB,
    policy: policyFromOptions(opts),
  });
  const outPath = opts.out ?? defaultOutPath(inputA, inputB);
  fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2));

  console.log(
    `Suite winner: ${verdict.winner} (A ${verdict.winsA}, B ${verdict.winsB}, ties ${verdict.ties})`,
  );
  // A tie from "we could not judge this" must not read as "these were close".
  const unjudgeable = verdict.perInput.filter((entry) => entry.unjudgeable).length;
  if (unjudgeable > 0) {
    console.log(
      `${unjudgeable} input(s) could not be judged (missing data or no goal) — counted as ties above`,
    );
  }
  console.log(`\nWrote verdict to ${outPath}`);
}

function inputMode(inputA: string, inputB: string): "files" | "dirs" | "mixed" {
  const aDir = fs.existsSync(inputA) && fs.statSync(inputA).isDirectory();
  const bDir = fs.existsSync(inputB) && fs.statSync(inputB).isDirectory();
  if (aDir && bDir) return "dirs";
  if (!aDir && !bDir) return "files";
  return "mixed";
}

function policyFromOptions(opts: EvalJudgeOptions): JudgeAggregationPolicy {
  return {
    samples: integerOption("samples", opts.samples ?? 3, { min: 1 }),
    confidenceThreshold: integerOption("confidenceThreshold", opts.confidenceThreshold ?? 50, {
      min: 0,
      max: 100,
    }),
    marginThreshold: integerOption("marginThreshold", opts.marginThreshold ?? 0, { min: 0 }),
    positionBias: opts.positionBias ?? "swap",
  };
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
  return path
    .basename(filePath)
    .replace(/\.(statelog\.)?jsonl$/, "")
    .replace(/\.eval\.json$/, "");
}
