import type { OptimizeTaskVerdict, OptimizeVerdict } from "./types.js";

export function buildOptimizeVerdict(args: {
  iter: number;
  championIter: number | "baseline";
  judgeSamples: number;
  acceptThreshold: number;
  perTask: OptimizeTaskVerdict[];
  mutationSummary: string;
}): OptimizeVerdict {
  const strong = args.perTask.filter((task) => task.confidence >= 50);
  const wins = strong.filter((task) => task.winner === "candidate").length;
  const losses = strong.filter((task) => task.winner === "champion").length;
  const ties = args.perTask.length - wins - losses;
  const margin = wins - losses;
  const decision = margin > args.acceptThreshold ? "accepted" : "rejected";
  return {
    iter: args.iter,
    championIter: args.championIter,
    judgeSamples: args.judgeSamples,
    acceptThreshold: args.acceptThreshold,
    perTask: args.perTask,
    wins,
    losses,
    ties,
    margin,
    decision,
    mutationSummary: args.mutationSummary,
    ...(strong.length === 0 ? { warning: "Task suite produced no confident signal." } : {}),
  };
}
