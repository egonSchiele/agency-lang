import type { AgencyConfig } from "@/config.js";

import type { BaseGrader } from "./grading/baseGrader.js";
import type { Input } from "./grading/types.js";
import type { OptimizeResult } from "./types.js";

/** What to optimize: an agent (file[:node]) and the inputs to run it on. */
export type OptimizeTarget = { agent: string; inputs: Input[] };

/** Cross-cutting config every optimizer needs; each optimizer may extend it. */
export type BaseOptimizerConfig = {
  graders: BaseGrader[];
  iterations: number;
  seed?: number;
  config: AgencyConfig;
  runsDir: string;
  runId: string;
  writeback?: boolean;
  mutatorModel?: string;
  /** Progress output verbosity. Defaults to silent (programmatic use); the CLI sets "default". */
  verbosity?: "silent" | "default";
};

/** A pluggable optimization strategy. */
export type Optimizer = {
  readonly name: string;
  optimize(target: OptimizeTarget): Promise<OptimizeResult>;
};

export type OptimizerFactory = (config: BaseOptimizerConfig) => Optimizer;
