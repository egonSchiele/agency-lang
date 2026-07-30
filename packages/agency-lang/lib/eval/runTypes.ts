import type { InputBreakdown } from "./grading/gradeBreakdown.js";

/** One invocation of an agent: which node, with which args, plus optional
 *  grading metadata. Shared by the eval runner and every optimizer. */
export type Input = {
  /** Stable identifier. Auto-derived when omitted: the loader generates one
   *  via nanoid, the optimizer derives it positionally (`input-<index>`). */
  id?: string;
  /** What the agent should accomplish — read by the goal judge and the
   *  pairwise judge suite. Optional; the input-file loader requires it. */
  goal?: string;
  /** Gold/expected output for this input (any JSON). Read by match graders
   *  (default matchOn) and surfaced to the optimizer's reflection. */
  expected?: any;
  /** Named arguments passed to the node. */
  args: Record<string, any>;
  /** Entry node to run. Overrides the node named by the --agent target
   *  (`--agent file:node`), which itself defaults to `main`. */
  node?: string;
  /** The test's fixture directory. Contents are copied into the workdir root;
   *  the agent's own files are seeded automatically from its import closure.
   *  A raw spec may hold a relative path (resolved against the inputs file) —
   *  after loading it is always an absolute directory path. */
  files?: string;
  /** Freeform, grader-agnostic metadata (tags, expectedOutput, …). */
  metadata?: Record<string, any>;
};

/** One input's EXECUTION record: did the process finish, and where its
 *  artifacts live. Exists whether or not anything was graded. Its judgment
 *  counterpart is grading's InputBreakdown (scores per grader), which can be
 *  regenerated later by `eval grade` without re-running anything. */
export type EvalRunInputResult = {
  inputId: string;
  status: "success" | "error";
  evalRecordPath: string;
  statelogPath: string;
  workdirPath: string;
  errorMessage?: string;
};

/** A run's score. Absent from EvalRunResult when grading was skipped. */
export type EvalRunGrading = {
  graders: string[];
  /** The run's aggregate grade, 0..1 (strictly: the objective function's
   *  VALUE for this run). Decided 2026-07-30: stays "objective" — one
   *  borrowed name beats two names across the eval/optimize seam. */
  objective: number;
  gatesPassed: boolean;
  perInput: InputBreakdown[];
};

/** Two questions live here, deliberately separate: `inputs` answers "did the
 *  agent crash?" (execution; always present), `grading` answers "how good was
 *  it?" (judgment; present only when graders ran). okCount/errorCount are
 *  denormalized from inputs[].status for one-glance summaries. Restructuring
 *  this split is named Level-2 work in the eval-cleanups spec. */
export type EvalRunResult = {
  runId: string;
  runDir: string;
  /** Display label, "<absolute agent path>:<node>". Not used to re-locate the
   *  agent — reproduction data lives in config.json's provenance. */
  agentLabel: string;
  inputs: EvalRunInputResult[];
  okCount: number;
  errorCount: number;
  /** Present unless grading was skipped (`--no-grade`). */
  grading?: EvalRunGrading;
};

