import { optimizeLoop, type OptimizeLoopDeps } from "./loop.js";
import type { Optimizer } from "./optimizer.js";
import type { OptimizeLoopConfig, OptimizeResult } from "./types.js";

/**
 * The PR #283 champion–challenger hill-climb, exposed as an Optimizer. Phase 1 delegates
 * verbatim to optimizeLoop (its pairwise judge stays internal) — zero behavior change.
 */
export class GreedyReflective implements Optimizer {
  readonly name = "greedy";

  optimize(config: OptimizeLoopConfig, deps: OptimizeLoopDeps = {}): Promise<OptimizeResult> {
    return optimizeLoop(config, deps);
  }
}
