import type { OptimizeLoopDeps } from "./loop.js";
import type { OptimizeLoopConfig, OptimizeResult } from "./types.js";

/**
 * A pluggable optimization strategy. Phase 1 keeps the contract shaped around the existing
 * OptimizeLoopConfig/OptimizeResult; later phases generalize it (graders, inputs) per
 * docs/superpowers/specs/2026-06-17-pluggable-optimizer-framework-design.md.
 */
export type Optimizer = {
  readonly name: string;
  optimize(config: OptimizeLoopConfig, deps?: OptimizeLoopDeps): Promise<OptimizeResult>;
};

export type OptimizerFactory = () => Optimizer;
