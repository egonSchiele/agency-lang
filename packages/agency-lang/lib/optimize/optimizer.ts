import type { AgencyConfig } from "@/config.js";

import type { GraderSource } from "@/eval/grading/gradeRun.js";
import type { Test } from "@/eval/grading/types.js";
import type { OptimizeResult } from "./types.js";

/** What to optimize: an agent (file[:node]) and the inputs to run it on,
 *  plus an optional held-out validation set used to pick the champion. */
export type OptimizeTarget = { agent: string; inputs: Test[]; validationInputs?: Test[] };

/** Cross-cutting config every optimizer needs; each optimizer may extend it. */
export type BaseOptimizerConfig = {
  /** The objective. "snapshot" (the CLI default with --suite): each input is
   *  graded by its own graders — the test's graders.ts and harness pairs,
   *  stored in its run directory the way eval run stores them, the goal
   *  judge for tests with neither. Candidate runs read the suite's grader
   *  files as they happen, so the same rule applies as to eval run: do not
   *  edit the suite while a search is running. "override" (--graders): one
   *  set for every input, the experiment knob. The grading layer's third
   *  source ("suite", re-grading old runs against live graders) has no
   *  meaning here, so the type excludes it. */
  graders: Extract<GraderSource, { kind: "snapshot" } | { kind: "override" }>;
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
