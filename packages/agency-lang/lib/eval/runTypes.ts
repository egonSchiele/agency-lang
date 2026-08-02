import type { InputBreakdown } from "./grading/gradeBreakdown.js";

/** One test case: what the agent is told, plus grading metadata. Nothing in
 *  here describes the agent — which file, which node, how the task lands is
 *  the runner's side of the line (--agent). Shared by the eval runner and
 *  every optimizer. */
export type Input = {
  /** Stable identifier. Auto-derived when omitted: the loader generates one
   *  via nanoid, the optimizer derives it positionally (`input-<index>`). */
  id?: string;
  /** What the agent is told: an instruction string, or a JSON object for
   *  agents that take structured data. Delivered as the entry node's single
   *  positional parameter (eval entry nodes take exactly one). Required;
   *  the loader rejects inputs without one. On-disk caveat: this type is
   *  also the shape of a run directory's input.json, and run dirs written
   *  before PR #739 carry args/node and NO task — read back off disk, task
   *  may be undefined there. Grading and judging read only goal/expected/
   *  metadata, so old runs still load. */
  task: string | Record<string, any>;
  /** The success criterion — read by the goal judge and the pairwise judge
   *  suite, never shown to the agent. Optional; required only when the
   *  default LLM judge will run. */
  goal?: string;
  /** Gold/expected output for this input (any JSON). Read by match graders
   *  (default matchOn) and surfaced to the optimizer's reflection. */
  expected?: any;
  /** The test's fixture directory. Contents are copied into the workdir root;
   *  the agent's own files are seeded automatically from its import closure.
   *  A raw spec may hold a relative path (resolved against the inputs file) —
   *  after loading it is always an absolute directory path. */
  files?: string;
  /** The test's own grading module (a TS file default-exporting graders) —
   *  success criteria are test-side, like goal and expected. Relative in a
   *  raw spec, absolute after loading. Auto-discovered in the test-directory
   *  form: a graders.ts beside test.json. Precedence at grading time:
   *  explicit --graders flag > this > eval.graders config > the goal judge.
   *  Trust note: graders are code the harness executes — pulling a remote
   *  suite means trusting it. */
  graders?: string;
  /** Per-test wall-clock override in seconds, test-side like terminal-bench's
   *  task.toml timeout_sec — a hard task may deserve more time than the
   *  suite default (eval.limits.wallClockSec). */
  timeoutSec?: number;
  /** Freeform, grader-agnostic metadata (tags, expectedOutput, …). */
  metadata?: Record<string, any>;
};

/** One input's EXECUTION record: did the process finish, and where its
 *  artifacts live. Exists whether or not anything was graded. Its judgment
 *  counterpart is grading's InputBreakdown (scores per grader), which can be
 *  regenerated later by `eval grade` without re-running anything. */
/** Denormalized from the input's eval record when the summary is
 *  written, so cross-run tools (the runs explorer) read one file per
 *  run instead of one record per input. Absent on runs written before
 *  this field existed and on inputs whose record is missing or
 *  unreadable — that absence routes the run to statelog backfill. */
export type InputMetricsSummary = {
  costUsd: number;
  durationMs: number;
  startedAtMs: number;
  models: string[];
  agentName?: string;
};

export type EvalRunInputResult = {
  inputId: string;
  status: "success" | "error";
  evalRecordPath: string;
  statelogPath: string;
  workdirPath: string;
  errorMessage?: string;
  metrics?: InputMetricsSummary;
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

