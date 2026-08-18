import type { InputBreakdown } from "./grading/gradeBreakdown.js";

/** One test case: what the agent is told, plus grading metadata. Nothing in
 *  here describes the agent — which file, which node, how the task lands is
 *  the runner's side of the line (--agent). Shared by the eval runner and
 *  every optimizer. */
export type Test = {
  /** Stable identifier. Auto-derived when omitted: the loader generates one
   *  via nanoid, the optimizer derives it positionally (`input-<index>`). */
  id?: string;
  /** What the agent is given: an instruction string, or a JSON object for
   *  agents that take structured data. Delivered as the entry node's single
   *  positional parameter (or as `{task}` for a command agent). Optional:
   *  an agent that takes no input runs a test with none, and then the entry
   *  node takes no parameter. Within one suite, either every test has an
   *  input or none does. */
  input?: string | Record<string, any>;
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

/** What `runSuite` returns, in memory: which tests ran, as which traces, and
 *  how each ended. Everything durable is in the run directory. */
export type SuiteTestResult = {
  testId: string;
  traceId: string;
  status: "success" | "error";
  errorMessage?: string;
};

export type SuiteRunResult = {
  runId: string;
  runDir: string;
  /** Display label, "<absolute agent path>:<node>" or the command string. */
  agentLabel: string;
  tests: SuiteTestResult[];
  okCount: number;
  errorCount: number;
};

/** A run's score, as `eval grade` reports it. */
export type EvalRunGrading = {
  graders: string[];
  /** The run's aggregate grade, 0..1 (strictly: the objective function's
   *  VALUE for this run). Decided 2026-07-30: stays "objective" — one
   *  borrowed name beats two names across the eval/optimize seam. */
  objective: number;
  gatesPassed: boolean;
  perInput: InputBreakdown[];
};
