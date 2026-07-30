import * as path from "path";

import { nanoid } from "nanoid";

import { resolveEvalRunTarget } from "@/agentTarget.js";
import type { AgencyConfig } from "@/config.js";
import {
  buildProvenance,
  initializeEvalRun,
  prepareInput,
  recordInputPrepareFailure,
  writeEvalRunSummary,
  type EvalRunProvenance,
  type PreparedInput,
  type SourceProvenance,
} from "@/eval/runArtifacts.js";
import type { EvalRunInputResult, EvalRunResult, Input } from "@/eval/runTypes.js";

import { runAgent, type AgentRun, type RunAgentOptions } from "./runAgent.js";
import { seedFromAgentFile } from "./seed.js";
import type { EvalInputRunner } from "./subprocess.js";

/** Per-run knobs forwarded verbatim to every runAgent call in the suite.
 *  Pick, not re-declaration: the compiler keeps this in sync with
 *  RunAgentOptions. NOTE the omission semantics shift at suite level: with
 *  `seed` omitted, runSuite computes ONE closure walk for the whole suite and
 *  passes it to every run — never one walk per input (RunAgentOptions.seed's
 *  own doc describes the single-run case). */
export type PerRunOptions = Pick<RunAgentOptions, "seed" | "overlayFiles" | "pipeOutput" | "extractor">;

/** Options for running a LOADED suite: parsed Input[], resolved values.
 *  The raw-flags side lives in the evalRun command (EvalRunCliOptions). */
export type RunSuiteOptions = {
  /** Agent target: path, path:node, or a directory meaning main.agency. */
  agent: string;
  inputs: Input[];
  runId?: string;
  runsDir?: string;
  /** Default true. */
  continueOnError?: boolean;
  config?: AgencyConfig;
  /** Source provenance recorded in config.json; "unspecified" when omitted. */
  provenance?: { inputsSource: SourceProvenance; files: Record<string, SourceProvenance> };
  perRun?: PerRunOptions;
};

/** Test seam, same pattern as RunAgentDeps. */
export type RunSuiteDeps = { runner?: EvalInputRunner };

/**
 * Run an agent against a loaded input suite and write the run directory:
 * per-input artifacts, provenance, summary. Executes only — grading reads
 * the finished directory separately (docs/dev/eval-grading.md).
 */
export async function runSuite(opts: RunSuiteOptions, deps: RunSuiteDeps = {}): Promise<EvalRunResult> {
  const target = resolveEvalRunTarget(opts.agent);

  const runsDir = path.resolve(
    opts.runsDir ?? opts.config?.eval?.runsDir ?? "runs",
  );
  const runId = opts.runId ?? nanoid();
  const continueOnError = opts.continueOnError ?? true;
  const config = opts.config ?? {};
  const perRun = opts.perRun ?? {};

  // One closure walk per suite; never per input.
  const defaultSeed = perRun.seed ?? seedFromAgentFile(target.agentFile);

  const provenance: EvalRunProvenance = buildProvenance({
    inputsSource: opts.provenance?.inputsSource ?? { source: "unspecified" },
    files: opts.provenance?.files ?? {},
    seed: defaultSeed,
  });

  const state = initializeEvalRun({
    runId,
    runsDir,
    agentLabel: target.label,
    inputs: opts.inputs,
    continueOnError,
    startedAt: new Date(),
    provenance,
  });

  const results: EvalRunInputResult[] = [];
  for (const input of opts.inputs) {
    let prepared: PreparedInput;
    try {
      prepared = prepareInput(state, input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runSuite] prepare failed for input ${input.id ?? ""}: ${message}`);
      results.push(recordInputPrepareFailure(input.id ?? "", message));
      if (!continueOnError) break;
      continue;
    }
    const run = await runAgent(target.agentFile, input.node ?? target.node, input.args, {
      runDir: prepared.inputDir,
      config,
      seedFiles: input.files,
      overlayFiles: perRun.overlayFiles,
      seed: defaultSeed,
      pipeOutput: perRun.pipeOutput ?? true,
      extractor: perRun.extractor,
    }, { runner: deps.runner });
    results.push(toInputResult(input, prepared, run));
    if (run.status === "error" && !continueOnError) break;
  }

  return writeEvalRunSummary(state, results);
}

/** An AgentRun in the suite's per-input vocabulary. */
function toInputResult(input: Input, prepared: PreparedInput, run: AgentRun): EvalRunInputResult {
  return {
    inputId: input.id ?? "",
    status: run.status,
    evalRecordPath: prepared.evalRecordPath,
    statelogPath: prepared.statelogPath,
    workdirPath: prepared.workdirPath,
    errorMessage: run.status === "error" ? run.errorMessage : undefined,
  };
}
