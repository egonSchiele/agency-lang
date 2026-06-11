import { judgePairwise } from "@/eval/judge/pairwise.js";
import type { PairwiseVerdict } from "@/eval/judge/types.js";

import type { OptimizeJudgeSample, OptimizeTaskVerdict, OptimizeWinner } from "./types.js";

export type PairwiseJudge = (
  rubric: string,
  recordPathA: string,
  recordPathB: string,
) => Promise<Pick<PairwiseVerdict, "winner" | "confidence" | "reasoning">>;

export async function judgeCandidateAgainstChampion(args: {
  taskId: string;
  rubric: string;
  championRecordPath: string;
  candidateRecordPath: string;
  samples: number;
  judge?: PairwiseJudge;
}): Promise<OptimizeTaskVerdict> {
  const judge = args.judge ?? judgePairwise;
  const samples: OptimizeJudgeSample[] = [];
  for (let sampleIndex = 0; sampleIndex < args.samples; sampleIndex += 1) {
    const championFirst = sampleIndex % 2 === 0;
    const recordA = championFirst ? args.championRecordPath : args.candidateRecordPath;
    const recordB = championFirst ? args.candidateRecordPath : args.championRecordPath;
    const verdict = await judge(args.rubric, recordA, recordB);
    samples.push({
      winner: mapWinner(verdict.winner, championFirst),
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
    });
  }
  return aggregateSamples(args.taskId, samples);
}

export function aggregateSamples(
  taskId: string,
  samples: OptimizeJudgeSample[],
): OptimizeTaskVerdict {
  const championVotes = samples.filter((sample) => sample.winner === "champion").length;
  const candidateVotes = samples.filter((sample) => sample.winner === "candidate").length;
  const winner = aggregateWinner(samples, championVotes, candidateVotes);
  return {
    taskId,
    winner,
    confidence: mean(samples.map((sample) => sample.confidence)),
    samples,
  };
}

function mapWinner(winner: "A" | "B" | "tie", championFirst: boolean): OptimizeWinner {
  if (winner === "tie") return "tie";
  if (winner === "A") return championFirst ? "champion" : "candidate";
  return championFirst ? "candidate" : "champion";
}

function aggregateWinner(
  samples: OptimizeJudgeSample[],
  championVotes: number,
  candidateVotes: number,
): OptimizeWinner {
  if (championVotes > candidateVotes) return "champion";
  if (candidateVotes > championVotes) return "candidate";
  const championMean = sideMean(samples, "champion");
  const candidateMean = sideMean(samples, "candidate");
  if (championMean > candidateMean) return "champion";
  if (candidateMean > championMean) return "candidate";
  return "tie";
}

function sideMean(samples: OptimizeJudgeSample[], side: "champion" | "candidate"): number {
  return mean(samples
    .filter((sample) => sample.winner === side || sample.winner === "tie")
    .map((sample) => sample.confidence));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
