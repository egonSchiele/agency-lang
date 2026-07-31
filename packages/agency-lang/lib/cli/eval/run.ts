import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { validateGraders } from "@/eval/grading/gradeRun.js";
import { recordGrading } from "@/eval/grading/recordGrading.js";
import { loadInputs, inputFromGoal } from "@/eval/loadInputs.js";
import type { EvalRecordExtractor } from "@/eval/run/extract.js";
import { runSuite } from "@/eval/run/runSuite.js";
import type { EvalInputRunner } from "@/eval/run/subprocess.js";
import type { SourceProvenance } from "@/eval/runArtifacts.js";
import type { EvalRunResult, Input } from "@/eval/runTypes.js";
import { parseSource, resolveSource } from "@/eval/sources.js";

import { resolveGraders } from "./graders.js";

export type EvalRunCliOptions = {
  agent: string;
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
  const selection = validateInputSelection(opts);
  // The command decides what "no --graders" means; the library primitive does not.
  const gradersPath = opts.graders ?? opts.config?.eval?.graders;
  const graders = await resolveGraders(gradersPath, opts.grade, opts.config ?? {});
  const suite = loadSuite({
    selection,
    inputs: opts.inputs,
    goal: opts.goal,
    // A goal is required only when the default goal judge will actually run it:
    // not under --no-grade, and not when a custom grading module is supplied.
    requireGoal: graders !== undefined && gradersPath === undefined,
    cacheRoot: opts.config?.eval?.sourceCacheRoot,
  });

  // Before any agent runs: a misconfigured grader should not cost a whole suite.
  if (graders) {
    validateGraders(graders, suite.inputs[0]);
  }

  const summary = await runSuite({
    agent: opts.agent,
    inputs: suite.inputs,
    provenance: suite.provenance,
    runId: opts.runId,
    runsDir: opts.runsDir,
    continueOnError: opts.continueOnError,
    config: opts.config,
    perRun: { extractor: deps.extractor },
  }, { runner: deps.runner });

  if (!graders || graders.length === 0) {
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
  const loadOptions = { requireGoal: args.requireGoal, filesProvenance, sourceCacheRoot: args.cacheRoot };
  const parsed = parseSource(args.inputs ?? "", process.cwd());
  if (parsed.kind === "git") {
    const resolved = resolveSource(parsed, { cacheRoot: args.cacheRoot });
    return {
      inputs: loadInputs(resolved.dir, nanoid, { ...loadOptions, forbidGitFiles: true }),
      provenance: { inputsSource: { source: args.inputs ?? "", sha: resolved.sha }, files: filesProvenance },
    };
  }
  return {
    inputs: loadInputs(parsed.path, nanoid, loadOptions),
    provenance: { inputsSource: { source: parsed.path }, files: filesProvenance },
  };
}

