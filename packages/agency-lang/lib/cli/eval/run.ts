import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadInputs, inlineInput } from "@/eval/loadInputs.js";
import { runSuite } from "@/eval/run/runSuite.js";
import type { EvalInputRunner } from "@/eval/run/subprocess.js";
import type { SuiteRunResult, Test } from "@/eval/runTypes.js";
import { parseSource, resolveSource } from "@/eval/sources.js";
import {
  describeEmptySelection,
  isEmptyFilter,
  selectTests,
  type TestFilter,
} from "@/eval/selectTests.js";
import type { SuiteIdentity } from "@/runDirectory/annotations.js";
import { evalRecordFor } from "@/runDirectory/evalRecord.js";
import { findRunDirectories } from "@/runDirectory/findRuns.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import { resolveEvalTarget } from "@/agentTarget.js";

export type EvalRunCliOptions = {
  /** File agent target. Exactly one of agent / agentCmd. */
  agent?: string;
  /** Command agent target: the command string with a {input} placeholder. */
  agentCmd?: string;
  /** The test suite: a JSON file, a directory, or a git source. */
  suite?: string;
  /** One inline test with this input text; no suite file needed. */
  input?: string;
  /** Directory to write the run directories into, one per test at `<out>/<testId>/`
   *  (default `<eval.runsDir or runs>/<timestamp>-<random suffix>`). */
  out?: string;
  config?: AgencyConfig;
  /** Worker-pool size (-n/--parallel); default 1 = sequential. */
  parallel?: number;
  /** `--test` id patterns; only matching tests run (suite runs only). */
  test?: string[];
  /** `--tags` values; only tests carrying every one run (suite runs only). */
  tags?: string[];
};

/** `--suite` runs a suite; otherwise the run is one inline test, with
 *  `--input`'s text or (for an agent that takes no argument) no input. */
export function validateInputSelection(opts: {
  suite?: string;
  input?: string;
}): "suite" | "input" {
  if (opts.suite && opts.input !== undefined) {
    throw new Error("Provide only one of --suite or --input");
  }
  return opts.suite ? "suite" : "input";
}

/**
 * The `agency eval run` command: load the suite, run it, write the run
 * directory. It never grades — `agency eval grade <dir>` does that, whenever
 * you like, and no `goal` is needed to run.
 */
export async function evalRun(
  opts: EvalRunCliOptions,
  /** Test seam — the CLI has no flag for it. */
  deps: { runner?: EvalInputRunner } = {},
): Promise<SuiteRunResult> {
  // Resolve first: exactly-one-of and the {input}-placeholder check belong
  // before anything loads or runs.
  const target = resolveEvalTarget({ agent: opts.agent, agentCmd: opts.agentCmd });
  const selection = validateInputSelection(opts);
  const filter: TestFilter = { ids: opts.test, tags: opts.tags };
  if (selection === "input" && !isEmptyFilter(filter)) {
    throw new Error("--test/--tags select from a suite; they do nothing with --input");
  }
  const suite = loadSuite({
    selection,
    source: opts.suite,
    input: opts.input,
    cacheRoot: opts.config?.eval?.sourceCacheRoot,
  });
  const tests = selectTests(suite.tests, filter);
  if (tests.length === 0) {
    throw new Error(describeEmptySelection(suite.tests, filter));
  }

  return runSuite(
    {
      agent: target,
      inputs: tests,
      suite: suite.identity,
      out: opts.out,
      config: opts.config,
      parallel: opts.parallel,
    },
    { runner: deps.runner },
  );
}

export type LoadedSuite = { tests: Test[]; identity: SuiteIdentity };

/** Load the suite named by --suite/--input, resolving a git source when given
 *  one and recording the resolved sha as the suite's identity. Running never
 *  needs a `goal`, so none is required here; `eval grade` takes one (`--goal`)
 *  or reads each test's own when its judge needs it. Exported for `eval ls`,
 *  which must see the suite exactly as a run would. */
export function loadSuite(args: {
  selection: "suite" | "input";
  source?: string;
  input?: string;
  cacheRoot?: string;
}): LoadedSuite {
  if (args.selection === "input") {
    return { tests: [inlineInput(args.input)], identity: { source: "inline:--input" } };
  }
  const loadOptions = { requireGoal: false, sourceCacheRoot: args.cacheRoot };
  const parsed = parseSource(args.source ?? "", process.cwd());
  if (parsed.kind === "git") {
    const resolved = resolveSource(parsed, { cacheRoot: args.cacheRoot });
    return {
      tests: loadInputs(resolved.dir, nanoid, { ...loadOptions, forbidGitFiles: true }),
      identity: { source: args.source ?? "", sha: resolved.sha },
    };
  }
  return { tests: loadInputs(parsed.path, nanoid, loadOptions), identity: { source: parsed.path } };
}

/** Total LLM spend across the run directories under `groupDir`, summed from
 *  each trace's metrics. Traces of interrupted runs count too, so an
 *  interrupted run still reports what it cost. Undefined when no trace
 *  carried a cost (or the group holds no runs yet). */
export function totalRunCostUsd(groupDir: string): number | undefined {
  let total: number | undefined;
  let runDirs: string[];
  try {
    runDirs = findRunDirectories([groupDir]);
  } catch {
    return undefined;
  }
  for (const dir of runDirs) {
    const snapshot = readRunDirectory(dir, { reportWarning: () => {} });
    for (const trace of snapshot.traces) {
      const cost = evalRecordFor(trace, snapshot.dir).metrics.costUsdTotal;
      if (typeof cost === "number" && Number.isFinite(cost)) {
        total = (total ?? 0) + cost;
      }
    }
  }
  return total;
}
