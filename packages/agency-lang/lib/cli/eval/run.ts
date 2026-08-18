import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadInputs, inputFromGoal } from "@/eval/loadInputs.js";
import { runSuite } from "@/eval/run/runSuite.js";
import type { EvalInputRunner } from "@/eval/run/subprocess.js";
import type { SuiteRunResult, Test } from "@/eval/runTypes.js";
import { parseSource, resolveSource } from "@/eval/sources.js";
import type { SuiteIdentity } from "@/runDirectory/annotations.js";
import { evalRecordFor } from "@/runDirectory/evalRecord.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import { resolveEvalTarget } from "@/agentTarget.js";

export type EvalRunCliOptions = {
  /** File agent target. Exactly one of agent / agentCmd. */
  agent?: string;
  /** Command agent target: the command string with a {task} placeholder. */
  agentCmd?: string;
  /** The test suite: a JSON file, a directory, or a git source. */
  suite?: string;
  goal?: string;
  runId?: string;
  runsDir?: string;
  continueOnError?: boolean;
  config?: AgencyConfig;
  /** Worker-pool size (-n/--parallel); default 1 = sequential. */
  parallel?: number;
};

export function validateInputSelection(opts: { suite?: string; goal?: string }): "suite" | "goal" {
  if (opts.suite && opts.goal) {
    throw new Error("Provide only one of --suite or --goal");
  }
  if (!opts.suite && !opts.goal) {
    throw new Error("Provide --suite or --goal");
  }
  return opts.goal ? "goal" : "suite";
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
  // Resolve first: exactly-one-of and the {task}-placeholder check belong
  // before anything loads or runs.
  const target = resolveEvalTarget({ agent: opts.agent, agentCmd: opts.agentCmd });
  const selection = validateInputSelection(opts);
  const suite = loadSuite({
    selection,
    source: opts.suite,
    goal: opts.goal,
    cacheRoot: opts.config?.eval?.sourceCacheRoot,
  });

  return runSuite(
    {
      agent: target,
      inputs: suite.tests,
      suite: suite.identity,
      runId: opts.runId,
      runsDir: opts.runsDir,
      continueOnError: opts.continueOnError,
      config: opts.config,
      parallel: opts.parallel,
    },
    { runner: deps.runner },
  );
}

type LoadedSuite = { tests: Test[]; identity: SuiteIdentity };

/** Load the suite named by --suite/--goal, resolving a git source when given
 *  one and recording the resolved sha as the suite's identity. Running never
 *  needs a `goal`, so none is required here; `eval grade` asks for one per
 *  test when its judge needs it. */
function loadSuite(args: {
  selection: "suite" | "goal";
  source?: string;
  goal?: string;
  cacheRoot?: string;
}): LoadedSuite {
  if (args.selection === "goal") {
    return { tests: [inputFromGoal(args.goal ?? "")], identity: { source: "inline:--goal" } };
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

/** Total LLM spend across a run directory's traces, summed from each trace's
 *  metrics. Traces of interrupted runs count too, so an interrupted run still
 *  reports what it cost. Undefined when no trace carried a cost. */
export function totalRunCostUsd(runDir: string): number | undefined {
  const snapshot = readRunDirectory(runDir, { reportWarning: () => {} });
  let total: number | undefined;
  for (const trace of snapshot.traces) {
    const cost = evalRecordFor(trace, snapshot.dir).metrics.costUsdTotal;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      total = (total ?? 0) + cost;
    }
  }
  return total;
}
