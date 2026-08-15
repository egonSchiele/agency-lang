import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { makeGraderModuleCache, validateGraders } from "@/eval/grading/gradeRun.js";
import { recordGrading } from "@/eval/grading/recordGrading.js";
import { loadInputs, inputFromGoal } from "@/eval/loadInputs.js";
import type { EvalRecordExtractor } from "@/eval/run/extract.js";
import { runSuite } from "@/eval/run/runSuite.js";
import type { EvalInputRunner } from "@/eval/run/subprocess.js";
import type { SourceProvenance } from "@/eval/runArtifacts.js";
import type { EvalRunResult, Input } from "@/eval/runTypes.js";
import { parseSource, resolveSource } from "@/eval/sources.js";

import * as fs from "fs";

import { resolveEvalTarget } from "@/agentTarget.js";

import { resolveGraders } from "./graders.js";

export type EvalRunCliOptions = {
  /** File agent target. Exactly one of agent / agentCmd. */
  agent?: string;
  /** Command agent target: the command string with a {task} placeholder. */
  agentCmd?: string;
  inputs?: string;
  goal?: string;
  runId?: string;
  runsDir?: string;
  continueOnError?: boolean;
  config?: AgencyConfig;
  /** Path to a TypeScript grading module. Defaults to `eval.graders` in agency.json. */
  graders?: string;
  /** False skips grading entirely (`--no-grade`). */
  grade?: boolean;
  /** Worker-pool size (-n/--parallel); default 1 = sequential. */
  parallel?: number;
};

export function validateInputSelection(opts: {
  inputs?: string;
  goal?: string;
}): "inputs" | "goal" {
  if (opts.inputs && opts.goal) {
    throw new Error("Provide only one of --inputs or --goal");
  }
  if (!opts.inputs && !opts.goal) {
    throw new Error("Provide --inputs or --goal");
  }
  return opts.goal ? "goal" : "inputs";
}

/**
 * The `agency eval run` command: resolve graders from flags, load the suite,
 * validate the graders, run the suite, record the grading. Each step is a
 * library call; the composition is the command's whole job.
 */
export async function evalRun(
  opts: EvalRunCliOptions,
  /** Test seam — the CLI has no flags for either field. */
  deps: {
    runner?: EvalInputRunner;
    extractor?: EvalRecordExtractor;
  } = {},
): Promise<EvalRunResult> {
  // Resolve first: exactly-one-of and the {task}-placeholder check belong
  // before anything loads or runs.
  const target = resolveEvalTarget({ agent: opts.agent, agentCmd: opts.agentCmd });
  const selection = validateInputSelection(opts);
  const graders = await resolveGraders(opts.graders, opts.grade, opts.config ?? {});
  const suite = loadSuite({
    selection,
    inputs: opts.inputs,
    goal: opts.goal,
    // A goal is required only where the default goal judge would actually
    // run: not under --no-grade, not when a suite-level module is supplied,
    // and (relaxed inside the loader) not for inputs carrying their own
    // graders.
    requireGoal:
      graders !== undefined &&
      opts.graders === undefined &&
      opts.config?.eval?.graders === undefined,
    cacheRoot: opts.config?.eval?.sourceCacheRoot,
  });

  // Before any agent runs: a misconfigured grader should not cost a whole
  // suite. Each input is validated against the grader set that will actually
  // score it — which per-test graders make per-input.
  if (graders) {
    const load = makeGraderModuleCache(opts.config ?? {});
    for (const input of suite.inputs) {
      const effective =
        graders.mode === "fallback" && input.graders !== undefined
          ? await load(input.graders)
          : graders.graders;
      validateGraders(effective, input);
    }
  }

  const summary = await runSuite(
    {
      agent: target,
      inputs: suite.inputs,
      provenance: suite.provenance,
      runId: opts.runId,
      runsDir: opts.runsDir,
      continueOnError: opts.continueOnError,
      config: opts.config,
      parallel: opts.parallel,
      perRun: { extractor: deps.extractor },
    },
    { runner: deps.runner },
  );

  // An empty override set means "grade with nothing" — skip, like --no-grade.
  // A fallback set is never empty: the goal judge backstops it, and an empty
  // eval.graders config module throws in resolveGraders.
  if (!graders || (graders.mode === "override" && graders.graders.length === 0)) {
    return summary;
  }
  summary.grading = await recordGrading(summary.runDir, graders, opts.config ?? {});
  return summary;
}

type LoadedSuite = {
  inputs: Input[];
  provenance: { inputsSource: SourceProvenance; files: Record<string, SourceProvenance> };
};

/** Load the suite named by --inputs/--goal, resolving a git source when given
 *  one, collecting source provenance for config.json as it goes. */
function loadSuite(args: {
  selection: "inputs" | "goal";
  inputs?: string;
  goal?: string;
  requireGoal: boolean;
  cacheRoot?: string;
}): LoadedSuite {
  if (args.selection === "goal") {
    return {
      inputs: [inputFromGoal(args.goal ?? "")],
      provenance: { inputsSource: { source: "inline:--goal" }, files: {} },
    };
  }
  // Null-prototype: input ids are user-controlled and the id charset allows
  // "__proto__", which on a plain object silently sets the prototype and
  // drops the entry from config.json. Same precedent as EvalCache.
  const filesProvenance: Record<string, SourceProvenance> = Object.create(null);
  const loadOptions = {
    requireGoal: args.requireGoal,
    filesProvenance,
    sourceCacheRoot: args.cacheRoot,
  };
  const parsed = parseSource(args.inputs ?? "", process.cwd());
  if (parsed.kind === "git") {
    const resolved = resolveSource(parsed, { cacheRoot: args.cacheRoot });
    return {
      inputs: loadInputs(resolved.dir, nanoid, { ...loadOptions, forbidGitFiles: true }),
      provenance: {
        inputsSource: { source: args.inputs ?? "", sha: resolved.sha },
        files: filesProvenance,
      },
    };
  }
  return {
    inputs: loadInputs(parsed.path, nanoid, loadOptions),
    provenance: { inputsSource: { source: parsed.path }, files: filesProvenance },
  };
}

/** Total LLM spend across a run's inputs, summed from each eval record's
 *  metrics. Salvaged records count too, so an interrupted run still reports
 *  what it cost. Undefined when no record carried a cost. */
export function totalRunCostUsd(result: EvalRunResult): number | undefined {
  let total: number | undefined;
  for (const input of result.inputs) {
    try {
      const record = JSON.parse(fs.readFileSync(input.evalRecordPath, "utf-8")) as {
        metrics?: { costUsdTotal?: unknown };
      };
      const cost = record.metrics?.costUsdTotal;
      if (typeof cost === "number" && Number.isFinite(cost)) {
        total = (total ?? 0) + cost;
      }
    } catch {
      // no record for this input (e.g. it never produced a statelog)
    }
  }
  return total;
}
