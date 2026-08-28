import type { InputBreakdown } from "./grading/gradeBreakdown.js";

/** One test case: what the agent is told, plus grading metadata. Nothing in
 *  here describes the agent — which file, which node, how the task lands is
 *  the runner's side of the line (--agent). Shared by the eval runner and
 *  every optimizer. */
export type AgencyTestVisibility = "visible" | "holdout";
/** A harness pair, `<name>.agency` + `<name>.test.json`, from the test's
 *  `files/` (the agent sees it) or `holdout/` (it does not). Absolute paths. */
export type AgencyTestDefinition = {
  name: string;
  agencyFile: string;
  testJsonFile: string;
  visibility: AgencyTestVisibility;
};

export type TestInput = string | Record<string, any>;

export type Test<T = TestInput> = {
  /** Stable identifier. Auto-derived when omitted: the loader generates one
   *  via nanoid, the optimizer derives it positionally (`input-<index>`). */
  id?: string;
  /** Why the test exists. Documentation only: never shown to the agent or
   *  a judge (the grading criterion is `goal`). */
  description?: string;
  /** Labels for selecting subsets of a suite (`eval run --tags`, previewed
   *  with `eval ls`): difficulty ("easy"), kind ("coding", "research"), or
   *  anything else. A test may carry several. Selection only — tags never
   *  reach the agent or a judge. */
  tags?: string[];
  /** What the agent is given: an instruction string, or a JSON object for
   *  agents that take structured data. Delivered as the entry node's single
   *  positional parameter (or as `{input}` for a command agent). Optional:
   *  an agent that takes no input runs a test with none, and then the entry
   *  node takes no parameter. Within one suite, either every test has an
   *  input or none does. */
  input?: T;
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
   *  form: a graders.ts beside test.json. A test without one is scored by
   *  the bundled goal judge against its `goal`.
   *  Trust note: graders are code the harness executes — pulling a remote
   *  suite means trusting it. */
  graders?: string;
  /** A directory of files for the graders alone, never seeded into the
   *  agent's workdir: reference answers, editing notes, expected output.
   *  Auto-discovered in the test-directory form as `graderFiles/` beside
   *  test.json. Relative in a raw spec, absolute after loading. Graders
   *  read it as `ctx.graderFiles`; `eval run` stores a copy in the run
   *  directory so a run grades the same later, anywhere. */
  graderFiles?: string;
  /** Discovered harness pairs (`files/*.test.json` visible, `holdout/*.test.json`
   *  hidden). Set by directory-convention discovery, never by suite JSON. */
  agencyTests?: AgencyTestDefinition[];
  /** Dollars each harness case may spend on LLM calls while being graded;
   *  the grader's default applies when absent. */
  harnessMaxCost?: number;
  /** Make the test's harness pairs gates: the test scores 0 unless every
   *  case passes. Off by default, so partial progress still scores. */
  harnessMustPass?: boolean;
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
  /** Which repetition of the test this was, 1-based; 1 for a single-trial suite. */
  trial: number;
  traceId: string;
  /** This test's run directory: `<group>/<testId>/`, or
   *  `<group>/<testId>/<trial>/` when the suite ran more than one trial. */
  runDir: string;
  status: "success" | "error";
  errorMessage?: string;
};

export type SuiteRunResult = {
  /** The group directory holding one run directory per test. */
  runDir: string;
  /** Display label, "<absolute agent path>:<node>" or the command string. */
  agentLabel: string;
  tests: SuiteTestResult[];
  okCount: number;
  errorCount: number;
  /** LLM spend summed from the finished runs' statelogs. */
  costUsd: number;
  /** True when `eval.limits.maxBatchCostUsd` was crossed: the tests after
   *  the crossing never started, so `tests` is shorter than the suite. */
  batchCostCapExceeded: boolean;
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
