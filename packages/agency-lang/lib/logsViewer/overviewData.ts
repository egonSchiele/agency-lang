import { roundsOf, type Round } from "./timeline/rounds.js";
import { hasRunningWork, spanExtent } from "./timeline/spans.js";
import type { TreeNode } from "./types.js";

export type OverviewData = {
  models: string[];
  running: boolean;
  elapsedMs: number;
  costUsd: number;
  rounds: Round[];
};

export function overviewData(trace: TreeNode): OverviewData {
  const rounds = roundsOf(trace);
  const models = rounds.map((round) => round.model).filter((model) => model !== "");
  const extent = spanExtent(trace);
  return {
    models: models.filter((model, index) => models.indexOf(model) === index),
    running: hasRunningWork(trace),
    elapsedMs: extent === undefined ? 0 : extent.end - extent.start,
    costUsd: rounds.reduce((total, round) => total + round.costUsd, 0),
    rounds,
  };
}
