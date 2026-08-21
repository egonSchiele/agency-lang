import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { nanoid } from "nanoid";

import { assertTargetMatchesInputs, resolveEvalTarget, type EvalTarget } from "@/agentTarget.js";
import { ttyColor } from "@/utils/termcolors.js";

import { makeStatelogCostTailer } from "./costTail.js";
import { formatElapsed, startStatusBoard } from "./statusBoard.js";
import type { AgencyConfig } from "@/config.js";
import type { SuiteRunResult, SuiteTestResult, Test } from "@/eval/runTypes.js";
import type { RunOutcome, SuiteIdentity } from "@/runDirectory/annotations.js";
import { recordedClosureHashes } from "@/runDirectory/attachCode.js";
import { computeCodeIdentity } from "@/runDirectory/codeIdentity.js";
import { recordCompletedRun } from "@/runDirectory/mutations.js";
import { snapshotGradingModule, type GradersSnapshot } from "@/eval/grading/gradingModule.js";
import { snapshotAgencyTestGraders } from "@/eval/grading/synthesizeGradersModule.js";
import { readTraces } from "@/runDirectory/traces.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";

import { agentRunPaths } from "./extract.js";
import { runAgent, type AgentRun, type RunAgentOptions } from "./runAgent.js";
import { seedFromAgentFile } from "./seed.js";
import type { EvalInputRunner } from "./subprocess.js";

/** Per-run knobs forwarded verbatim to every runAgent call in the suite.
 *  Pick, not re-declaration: the compiler keeps this in sync with
 *  RunAgentOptions. NOTE the omission semantics shift at suite level: with
 *  `seed` omitted, runSuite computes ONE closure walk for the whole suite and
 *  passes it to every run — never one walk per input (RunAgentOptions.seed's
 *  own doc describes the single-run case). */
export type PerRunOptions = Pick<RunAgentOptions, "seed" | "overlayFiles" | "pipeOutput">;

/** Options for running a LOADED suite: parsed Test[], resolved values.
 *  The raw-flags side lives in the evalRun command (EvalRunCliOptions). */
export type RunSuiteOptions = {
  /** The agent. A string is file-target convenience (path, path:node, or a
   *  directory meaning main.agency) and is resolved here; a resolved
   *  EvalTarget passes through with no re-validation — it already passed
   *  resolveEvalTarget, including the {input}-placeholder check. */
  agent: string | EvalTarget;
  inputs: Test[];
  /** The group directory; each test's run directory is written at
   *  `<out>/<testId>/`. Default: `<eval.runsDir or runs>/<timestamp>-<random suffix>`. */
  out?: string;
  /** Default true. */
  config?: AgencyConfig;
  /** Worker-pool size for input scheduling; 1 (default) = sequential with
   *  piped agent output, >1 = parallel with a status board instead. */
  parallel?: number;
  /** Default true: suite-level progress on stderr (the run-dir line, the
   *  per-input heartbeat and status lines, the parallel status board). The
   *  optimizer turns it off — its reporter owns the narrative, and
   *  `optimize --silent` must print nothing at all. */
  progress?: boolean;
  /** Where the suite came from, recorded on every test's `run` annotation. */
  suite?: SuiteIdentity;
  perRun?: PerRunOptions;
};

/** Test seam, same pattern as RunAgentDeps. */
export type RunSuiteDeps = { runner?: EvalInputRunner };

/**
 * Run an agent against a loaded suite and write one run directory per test
 * at `<out>/<testId>/`: the test's trace in `statelog.jsonl`, its workdir
 * under `workdir/`, the agent's code under `code/`, and one `run` annotation
 * saying which test it was and how it ended. A test whose directory already
 * exists is an error result; the others still run. Executes only — grading is
 * a separate pass over the finished directories (docs/dev/eval-grading.md).
 */
export async function runSuite(
  opts: RunSuiteOptions,
  deps: RunSuiteDeps = {},
): Promise<SuiteRunResult> {
  const target: EvalTarget =
    typeof opts.agent === "string" ? resolveEvalTarget({ agent: opts.agent }) : opts.agent;
  // Before any workdir is seeded or agent compiled: an agent whose shape
  // does not match the tests' inputs is a configuration error, not a
  // per-test run failure.
  assertTargetMatchesInputs(target, opts.inputs);

  const groupDir = path.resolve(
    opts.out ?? path.join(opts.config?.eval?.runsDir ?? "runs", defaultGroupName()),
  );
  const config = opts.config ?? {};
  const perRun = opts.perRun ?? {};

  // Each test's graders, bundled now and stored in its run directory, so the
  // run grades later by the graders it ran with, wherever the directory goes.
  // A broken grading module fails here, before any agent runs.
  const gradersByTest: Record<string, TestGraders | undefined> = await snapshotGraders(
    opts.inputs,
    config,
    opts.suite,
  );

  // One closure walk per suite; never per test. Command targets have no
  // closure and nothing to compile. Before any directory is created: a
  // missing agent is a setup failure, not a run.
  const defaultSeed =
    target.kind === "file" ? (perRun.seed ?? seedFromAgentFile(target.agentFile)) : undefined;

  // Each test runs in its own staging directory inside the group and its run
  // directory is assembled there too, then renamed into place: a child appears
  // whole or not at all, and the rename never crosses filesystems.
  const stagingRoot = path.join(groupDir, ".staging");
  fs.mkdirSync(stagingRoot, { recursive: true });

  // Up front, not just at the end: a long run's evidence (statelogs, the
  // live `eval logs -f` view) lives here while it is still running.
  const progress = opts.progress ?? true;
  if (progress) console.error(`run dir: ${groupDir}`);

  // Ctrl-C mid-suite must still produce a run directory the toolchain can
  // read: the in-flight test finishes as an error result (the runner kills
  // its child), is folded in, and the loop stops. `once`, so a second
  // Ctrl-C gets default handling — immediate death.
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    console.warn(
      "\neval run interrupted — folding the in-flight test into the run directory; " +
        "press Ctrl-C again to force quit",
    );
  };
  process.once("SIGINT", onSigint);

  const parallel = Math.max(1, Math.floor(opts.parallel ?? 1));
  // `agent` is the target's label (an agent file path or the command line),
  // so a listing can say which agent a directory's runs came from.
  const flags: Record<string, string | number | boolean> = {
    parallel,
    agent: target.label,
  };
  const harness = { kind: "harness" as const, id: `agency-eval@${harnessVersion()}` };

  // One test, executed, folded into the run directory, and its staging
  // removed — shared by both scheduling modes. Prepare failures become error
  // results, not throws. `onStarted` fires before the agent starts, so the
  // pool can begin tailing the statelog while the run is live.
  const executeTest = async (
    test: Test,
    pipeOutput: boolean,
    onStarted?: (statelogPath: string) => void,
  ): Promise<SuiteTestResult> => {
    const testId = test.id ?? "";
    const traceId = nanoid();
    const runDir = path.join(groupDir, testId);
    const idProblem = testIdProblem(testId, groupDir, runDir);
    if (idProblem !== undefined) {
      return { testId, traceId, runDir, status: "error", errorMessage: idProblem };
    }
    if (fs.existsSync(runDir)) {
      // Someone's data; not ours to touch. (Resume is deliberately not here.)
      return {
        testId,
        traceId,
        runDir,
        status: "error",
        errorMessage: `run directory already exists: ${runDir}`,
      };
    }
    const stagingDir = path.join(stagingRoot, testId);
    onStarted?.(agentRunPaths(stagingDir).statelogPath);
    try {
      const run = await runAgent(
        target,
        test.input,
        {
          runDir: stagingDir,
          traceId,
          config,
          seedFiles: test.files,
          overlayFiles: perRun.overlayFiles,
          seed: defaultSeed,
          pipeOutput,
          timeoutSec: test.timeoutSec,
        },
        { runner: deps.runner },
      );
      const assembled = path.join(stagingRoot, `${testId}.rundir`);
      fs.rmSync(assembled, { recursive: true, force: true });
      foldIntoRunDirectory({
        runDir: assembled,
        test,
        traceId,
        run,
        harness,
        suite: opts.suite,
        graders: gradersByTest[testId],
        flags,
      });
      fs.renameSync(assembled, runDir);
      return {
        testId,
        traceId,
        runDir,
        status: run.status,
        errorMessage: run.status === "error" ? run.errorMessage : undefined,
      };
    } finally {
      const deleted = safeDeleteDirectoryWithin(stagingRoot, stagingDir);
      if (!deleted.success && fs.existsSync(stagingDir)) {
        console.warn(`[runSuite] could not remove staging ${stagingDir}: ${deleted.message}`);
      }
    }
  };

  let results: SuiteTestResult[] = [];
  try {
    if (parallel === 1) {
      results = await runSequential({
        tests: opts.inputs,
        progress,
        pipeOutput: perRun.pipeOutput ?? true,
        isInterrupted: () => interrupted,
        executeTest,
      });
    } else {
      if (progress) printLiveStatelogPaths(opts.inputs, stagingRoot, groupDir);
      results = await runPool({
        tests: opts.inputs,
        parallel,
        progress,
        isInterrupted: () => interrupted,
        executeTest,
      });
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    removeIfEmpty(stagingRoot);
  }

  return {
    runDir: groupDir,
    agentLabel: target.label,
    tests: results,
    okCount: results.filter((result) => result.status === "success").length,
    errorCount: results.filter((result) => result.status === "error").length,
  };
}

/** A test's snapshot plus where its module came from: its own spec, or the
 *  `eval.graders` config fallback. The origin is recorded on the run row so
 *  grading can honor `--goal`, which sets configured modules aside but never
 *  a test's own. */
type TestGraders = GradersSnapshot & { origin: "test" | "config" };

/** The grading module each test will be graded with — its own, else the
 *  project's `eval.graders` — bundled once per distinct module. Tests with
 *  neither get no snapshot: the bundled goal judge needs none. */
async function snapshotGraders(
  tests: Test[],
  config: AgencyConfig,
  suite: SuiteIdentity | undefined,
): Promise<Record<string, TestGraders | undefined>> {
  const byModule: Record<string, Promise<GradersSnapshot>> = Object.create(null);
  const byTest: Record<string, TestGraders | undefined> = Object.create(null);
  for (const test of tests) {
    if (test.agencyTests !== undefined && test.agencyTests.length > 0 && test.id !== undefined) {
      // Discovered agency tests: synthesize one module (sibling graders.ts
      // composed in) with a stable revision. Preflight refusals inside —
      // malformed json, approve answers, non-sibling sourceFile — happen
      // here, before any agent runs.
      byTest[test.id] = { ...(await snapshotAgencyTestGraders({ test, suite })), origin: "test" };
      continue;
    }
    const modulePath = test.graders ?? config.eval?.graders;
    if (modulePath === undefined || test.id === undefined) continue;
    byModule[modulePath] ??= snapshotGradingModule(modulePath);
    const origin = test.graders !== undefined ? ("test" as const) : ("config" as const);
    byTest[test.id] = { ...(await byModule[modulePath]), origin };
  }
  return byTest;
}

/** Assemble one finished run's directory: its trace, its workdir, the agent's
 *  code, and the `run` row. A run that never wrote a statelog still gets its
 *  `run` row (keyed by the trace id the harness minted) and an empty
 *  `statelog.jsonl`, so a failure is recorded rather than lost and the
 *  directory is still a run directory; it gets no workdir, because a workdir
 *  needs a trace to hang off. */
function foldIntoRunDirectory(args: {
  runDir: string;
  test: Test;
  traceId: string;
  run: AgentRun;
  harness: { kind: "harness"; id: string };
  suite: SuiteIdentity | undefined;
  graders: TestGraders | undefined;
  flags: Record<string, string | number | boolean>;
}): void {
  const { run } = args;
  fs.mkdirSync(args.runDir, { recursive: true });
  const staged = run.statelogPath === null ? [] : readTraces(run.statelogPath).traces;
  if (staged.length === 0) fs.writeFileSync(path.join(args.runDir, "statelog.jsonl"), "");
  const trace = staged.find((entry) => entry.traceId === args.traceId);
  const traceRecorded = trace !== undefined;
  // Attach the seeded code only when the trace itself recorded that closure
  // (a child running an older runtime records none); the code tree must
  // never contradict the trace.
  const codeEntry =
    trace !== undefined &&
    run.seededAgentEntry !== null &&
    recordedClosureHashes([trace]).includes(computeCodeIdentity(run.seededAgentEntry).closureHash)
      ? run.seededAgentEntry
      : undefined;
  recordCompletedRun({
    dir: args.runDir,
    stagedStatelogFile: run.statelogPath === null ? undefined : run.statelogPath,
    codeEntry,
    workdir: traceRecorded && fs.existsSync(run.workdir) ? { sourceDir: run.workdir } : undefined,
    gradersFiles: args.graders?.files,
    run: {
      traceId: args.traceId,
      annotator: args.harness,
      payload: {
        kind: "run",
        // JSON round trip: the loader leaves optional fields as `undefined`,
        // which is not a JSON value; on disk they are simply absent.
        test: JSON.parse(JSON.stringify(args.test)),
        suite: args.suite ?? null,
        ...(args.graders === undefined
          ? {}
          : {
              graders: {
                source: args.graders.source,
                bundleFile: args.graders.bundleFile,
                judgeFiles: args.graders.judgeFiles,
                origin: args.graders.origin,
                ...(args.graders.revision === undefined
                  ? {}
                  : { revision: args.graders.revision }),
              },
            }),
        ended: endedFrom(run),
        flags: args.flags,
        ...(run.status === "error" ? { error: run.errorMessage } : {}),
      },
    },
  });
}

/** How the harness saw the run end. Only the harness knows it killed a run
 *  at the wall clock or the cost cap; the runner's message says which. */
function endedFrom(run: AgentRun): RunOutcome {
  if (run.status === "success") return "ok";
  const message = run.errorMessage;
  if (/wall clock/i.test(message)) return "timeout";
  if (/cost cap/i.test(message)) return "cost-cap";
  if (/SIGINT|interrupted/i.test(message)) return "killed";
  return "error";
}

/**
 * Parallel scheduling: a pool of workers pulls inputs in order. Agent output
 * is never piped (n interleaved streams are noise — `eval logs <dir> -f` is
 * the drill-down); a status board shows each test's state, elapsed time, and
 * cost so far (tailed from its live statelog every second). An errored test
 * never stops the others (it is a `run` row that grades 0); an interrupt
 * stops SCHEDULING and in-flight runs settle normally (their forwarded
 * SIGINT kills their trees and they come back as error results). Results
 * keep input order.
 */
async function runPool(args: {
  tests: Test[];
  parallel: number;
  progress: boolean;
  isInterrupted: () => boolean;
  executeTest: (
    test: Test,
    pipeOutput: boolean,
    onStarted?: (statelogPath: string) => void,
  ) => Promise<SuiteTestResult>;
}): Promise<SuiteTestResult[]> {
  const board = args.progress
    ? startStatusBoard(args.tests.map((test) => test.id ?? ""))
    : { update: () => {}, stop: () => {} };
  const slots: (SuiteTestResult | undefined)[] = new Array(args.tests.length);
  const costTails: (() => number)[] = [];
  let nextIndex = 0;

  const costPoll = setInterval(() => {
    for (const poll of costTails) poll();
  }, 1_000);

  const worker = async (): Promise<void> => {
    for (;;) {
      if (args.isInterrupted()) return;
      const index = nextIndex++;
      if (index >= args.tests.length) return;
      const test = args.tests[index];
      const id = test.id ?? "";
      board.update(id, { status: "running", startedAt: Date.now() });

      const outcome = await args.executeTest(test, false, (statelogPath) => {
        // Tail this run's statelog for the board's cost column, from run
        // start; the tail stays registered afterwards so the final cost
        // sticks.
        const tailer = makeStatelogCostTailer(statelogPath);
        costTails.push(() => {
          const total = tailer.poll();
          board.update(id, { costUsd: total });
          return total;
        });
      });
      slots[index] = outcome;
      board.update(id, {
        status: outcome.status === "error" ? "error" : "done",
        endedAt: Date.now(),
      });
    }
  };

  try {
    await Promise.all(Array.from({ length: args.parallel }, () => worker()));
  } finally {
    for (const poll of costTails) poll();
    clearInterval(costPoll);
    board.stop();
  }
  return slots.filter((entry): entry is SuiteTestResult => entry !== undefined);
}

/**
 * Sequential scheduling: one test at a time with piped agent output, a
 * heartbeat on stderr so an agent quietly inside one long LLM call does not
 * read as a hang, and the live statelog path announced as each test starts.
 */
async function runSequential(args: {
  tests: Test[];
  progress: boolean;
  pipeOutput: boolean;
  isInterrupted: () => boolean;
  executeTest: (
    test: Test,
    pipeOutput: boolean,
    onStarted?: (statelogPath: string) => void,
  ) => Promise<SuiteTestResult>;
}): Promise<SuiteTestResult[]> {
  const results: SuiteTestResult[] = [];
  for (const test of args.tests) {
    const startedAt = Date.now();
    const label = ttyColor.green(test.id ?? "");
    const ticker = args.progress
      ? setInterval(() => {
          console.error(`[${label}] running… ${formatElapsed(Date.now() - startedAt)}`);
        }, 15_000)
      : undefined;
    let outcome: SuiteTestResult;
    try {
      outcome = await args.executeTest(
        test,
        args.pipeOutput,
        liveStatelogAnnouncer(args.progress, label),
      );
    } finally {
      if (ticker !== undefined) clearInterval(ticker);
    }
    if (args.progress) {
      const status = outcome.status === "error" ? ttyColor.red("error") : outcome.status;
      console.error(`[${label}] ${status} in ${formatElapsed(Date.now() - startedAt)}`);
    }
    results.push(outcome);
    if (args.isInterrupted()) break;
  }
  return results;
}

/** The only address a watcher can follow while a run is still in staging,
 *  announced the moment the test starts (sequential mode). */
function liveStatelogAnnouncer(
  progress: boolean,
  label: string,
): ((statelogPath: string) => void) | undefined {
  if (!progress) return undefined;
  return (statelogPath) => console.error(`[${label}] live statelog: ${statelogPath}`);
}

/** Before the status board takes the screen: each test’s live statelog
 *  address, so a watcher can follow a run while it is still in staging. The
 *  paths are deterministic, so they can all be printed up front. */
function printLiveStatelogPaths(tests: Test[], stagingRoot: string, groupDir: string): void {
  for (const test of tests) {
    const testId = test.id ?? "";
    // An invalid id never stages (executeTest errors first), so a path
    // built from it would point somewhere no run will ever live.
    if (testIdProblem(testId, groupDir, path.join(groupDir, testId)) !== undefined) continue;
    const statelogPath = agentRunPaths(path.join(stagingRoot, testId)).statelogPath;
    console.error(`[${ttyColor.green(testId)}] live statelog: ${statelogPath}`);
  }
}

/** A test id is a directory name under the group: it must be non-empty and
 *  resolve to a direct child (no separators, no `..`, not `.staging`). Suite
 *  loaders already restrict ids, but `runSuite` is also called directly. */
function testIdProblem(testId: string, groupDir: string, runDir: string): string | undefined {
  if (testId === "") return "test has no id; a run directory needs a name";
  if (path.dirname(path.resolve(runDir)) !== groupDir || path.basename(runDir) !== testId) {
    return `test id "${testId}" is not a valid directory name under ${groupDir}`;
  }
  if (testId === ".staging") return `test id ".staging" is reserved`;
  return undefined;
}

/** Default group directory name: local-time timestamp then a short random
 *  suffix, so runs/ lists in creation order. An explicit --out is resolved to
 *  an absolute path and used as the group directory. */
function defaultGroupName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${nanoid(6)}`;
}

/** The staging root is shared by concurrent suites writing one group; only
 *  the last one out removes it. */
function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty, or already gone — either is fine
  }
}

/** The harness's own version, for the `run` row's annotator id. */
function harnessVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 5; index += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
        return parsed.version ?? "unknown";
      } catch {
        return "unknown";
      }
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}
