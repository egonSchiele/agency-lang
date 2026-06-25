/** One invocation of an agent: which node, with which args, plus optional
 *  grading metadata. Shared by the eval runner and every optimizer. */
export type Input = {
  /** Stable identifier. Auto-derived when omitted: the loader generates one
   *  via nanoid; the optimizer derives it positionally (`input-<index>`). */
  id?: string;
  /** What the agent should accomplish — read by the goal judge and the
   *  pairwise judge suite. Optional; the input-file loader requires it. */
  goal?: string;
  /** Gold/expected output for this input (any JSON). Read by match graders
   *  (default matchOn) and surfaced to the optimizer's reflection. */
  expected?: any;
  /** Named arguments passed to the node. */
  args: Record<string, any>;
  /** Entry node to run. Defaults to the agent's default node at run time. */
  node?: string;
  /** Directory copied into the run's workdir before execution. */
  working_dir?: string;
  /** Freeform, grader-agnostic metadata (tags, expectedOutput, …). */
  metadata?: Record<string, any>;
};

export type EvalRunInputResult = {
  inputId: string;
  status: "success" | "error";
  evalRecordPath: string;
  statelogPath: string;
  workdirPath: string;
  errorMessage?: string;
};

export type EvalRunResult = {
  runId: string;
  runDir: string;
  agent: string;
  inputs: EvalRunInputResult[];
  okCount: number;
  errorCount: number;
};

export type EvalRunConfig = {
  runId: string;
  runsDir: string;
  agent: string;
  inputs: Input[];
  inputsSource: string;
  continueOnError: boolean;
  verbose?: boolean;
};
