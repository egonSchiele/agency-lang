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
   *  resolveEvalTarget, including the {task}-placeholder check. */
  agent: string | EvalTarget;
  inputs: Test[];
  /** The directory to write the run into. Must not exist yet. Default:
   *  `<eval.runsDir or runs>/<timestamp-suffix>`. */
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
 * Run an agent against a loaded suite and write ONE run directory: every
 * test's trace in `statelog.jsonl`, its workdir under `workdir/<traceId>/`,
 * the agent's code under `code/<closureHash>/`, and one `run` annotation per
 * test saying which test it was and how it ended. Executes only — grading is
 * a separate pass over the finished directory (docs/dev/eval-grading.md).
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

  const runDir = path.resolve(
    opts.out ?? path.join(opts.config?.eval?.runsDir ?? "runs", defaultRunDirName()),
  );
  if (fs.existsSync(runDir)) {
    throw new Error(
      `Run directory already exists: ${runDir}\nChoose a different --out directory or delete the existing one.`,
    );
  }
  const stagingParent = path.join(path.dirname(runDir), ".staging");
  const config = opts.config ?? {};
  const perRun = opts.perRun ?? {};

  // One closure walk per suite; never per test. Command targets have no
  // closure and nothing to compile. Before any directory is created: a
  // missing agent is a setup failure, not a run.
  const defaultSeed =
    target.kind === "file" ? (perRun.seed ?? seedFromAgentFile(target.agentFile)) : undefined;

  // Each test runs in its own staging directory OUTSIDE the run directory and
  // is folded in when it finishes; the staging root lives beside the run
  // directory so the fold never crosses filesystems.
  const stagingRoot = path.join(stagingParent, path.basename(runDir));
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });

  // Up front, not just at the end: a long run's evidence (statelogs, the
  // live `eval logs -f` view) lives here while it is still running.
  const progress = opts.progress ?? true;
  if (progress) console.error(`run dir: ${runDir}`);

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
      foldIntoRunDirectory({ runDir, test, traceId, run, harness, suite: opts.suite, flags });
      return {
        testId,
        traceId,
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
      for (const test of opts.inputs) {
        // Progress heartbeat: agents legitimately go quiet for a minute
        // inside one LLM call, and a silent terminal reads as a hang.
        // stderr, so piped agent output and result printing stay clean.
        const startedAt = Date.now();
        const label = ttyColor.green(test.id ?? "");
        const ticker = progress
          ? setInterval(() => {
              console.error(`[${label}] running… ${formatElapsed(Date.now() - startedAt)}`);
            }, 15_000)
          : undefined;
        let outcome: SuiteTestResult;
        try {
          outcome = await executeTest(test, perRun.pipeOutput ?? true);
        } finally {
          if (ticker !== undefined) clearInterval(ticker);
        }
        if (progress) {
          const status = outcome.status === "error" ? ttyColor.red("error") : outcome.status;
          console.error(`[${label}] ${status} in ${formatElapsed(Date.now() - startedAt)}`);
        }
        results.push(outcome);
        if (interrupted) break;
      }
    } else {
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
    safeDeleteDirectoryWithin(stagingParent, stagingRoot);
    removeIfEmpty(stagingParent);
  }

  return {
    runDir,
    agentLabel: target.label,
    tests: results,
    okCount: results.filter((result) => result.status === "success").length,
    errorCount: results.filter((result) => result.status === "error").length,
  };
}

/** Fold one finished run into the run directory: its trace, its workdir, the
 *  agent's code, and the `run` row. A run that never wrote a statelog still
 *  gets its `run` row (keyed by the trace id the harness minted), so a
 *  failure is recorded rather than lost; it gets no workdir, because a
 *  workdir needs a trace to hang off. */
function foldIntoRunDirectory(args: {
  runDir: string;
  test: Test;
  traceId: string;
  run: AgentRun;
  harness: { kind: "harness"; id: string };
  suite: SuiteIdentity | undefined;
  flags: Record<string, string | number | boolean>;
}): void {
  const { run } = args;
  const staged = run.statelogPath === null ? [] : readTraces(run.statelogPath).traces;
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
    workdir:
      traceRecorded && fs.existsSync(run.workdir)
        ? { traceId: args.traceId, sourceDir: run.workdir }
        : undefined,
    run: {
      traceId: args.traceId,
      annotator: args.harness,
      payload: {
        kind: "run",
        // JSON round trip: the loader leaves optional fields as `undefined`,
        // which is not a JSON value; on disk they are simply absent.
        test: JSON.parse(JSON.stringify(args.test)),
        suite: args.suite ?? null,
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

/** Default run directory name: local-time timestamp then a short random
 *  suffix, so runs/ lists in creation order. An explicit --out is used verbatim. */
function defaultRunDirName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${nanoid(6)}`;
}

/** The staging root is shared by concurrent suites in one runs dir; only the
 *  last one out removes it. */
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
