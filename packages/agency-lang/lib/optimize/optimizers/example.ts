import type { EvalTask } from "@/eval/runTypes.js";

import { BaseOptimizer, type BaseOptimizerDeps } from "../baseOptimizer.js";
import type { Input } from "../grading/types.js";
import { proposeMutation, type ProposeMutationArgs } from "../mutator.js";
import type { BaseOptimizerConfig } from "../optimizer.js";
import { defaultPreview, type OptimizeMutationOperation, type OptimizeMutationPreview } from "../sourceMutator.js";
import { fileMap, type OptimizeTargetSet } from "../targets.js";
import type { MutationProposal, OptimizeResult } from "../types.js";

/**
 * Optional injection points, so the optimizer can be unit-tested without an LLM
 * or real file edits. The registry constructs it with none — `new ExampleOptimizer(config)`.
 */
export type ExampleDeps = BaseOptimizerDeps & {
  propose?: (args: ProposeMutationArgs) => Promise<MutationProposal>;
  preview?: (targetSet: OptimizeTargetSet, operations: OptimizeMutationOperation[]) => OptimizeMutationPreview;
};

/**
 * The smallest useful optimizer — a copy-paste template for writing your own.
 *
 * Every optimizer extends {@link BaseOptimizer} and implements
 * {@link optimizeTargets}. By the time it runs, the base class has already
 * resolved the agent file and discovered its `optimize` targets; your job is to
 * search for better target values and return the best candidate.
 *
 * This one runs a single round: score the agent as-is, ask the built-in mutator
 * for one new set of values, score those, and keep whichever scored higher. The
 * real optimizers (greedy, gepa) loop and search more cleverly, but they all
 * follow the same shape — fork → apply → evaluate → compare → report → return.
 *
 * Protected helpers available from BaseOptimizer:
 *   - `this.fork(dir)` — copy the agent into an isolated workspace
 *   - `this.workspace.applyFiles(ws, files)` — write candidate files into it
 *   - `this.evaluate(ws, entryFile, inputs)` — run + grade, returns a Scorecard
 *   - `this.reporter` — progress output (silent unless the CLI sets verbosity)
 *   - `this.buildPointwiseResult(...)` — package the OptimizeResult
 *   - `this.config` — graders, runId, writeback, mutatorModel, …
 *
 * Register it (see registry.ts):
 *   registerOptimizer("example", (config) => new ExampleOptimizer(config));
 */
export class ExampleOptimizer extends BaseOptimizer {
  readonly name = "example";

  constructor(config: BaseOptimizerConfig, private readonly exampleDeps: ExampleDeps = {}) {
    super(config, exampleDeps);
  }

  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
    const startedAt = Date.now();
    this.reporter.runStarted({
      optimizer: this.name, runId: this.config.runId,
      targets: source.targets, inputCount: inputs.length, iterations: 1,
    });

    // 1. Score the unchanged agent.
    const baseline = await this.score(source, fileMap(source), inputs);
    this.reporter.baselineScored({ objective: baseline });

    // 2. Ask the built-in mutator for one new set of target values. proposeValidMutation
    //    (from BaseOptimizer) retries on validation errors and never throws on a bad response.
    const outcome = await this.proposeValidMutation(
      (diagnostics) => (this.exampleDeps.propose ?? proposeMutation)({
        config: this.config.config,
        targets: source.targets,
        tasks: inputsAsTasks(inputs),
        history: "",
        model: this.config.mutatorModel,
        diagnostics,
      }),
      (operations) => (this.exampleDeps.preview ?? defaultPreview)(source, operations),
    );

    // 3. If we got a valid proposal, score it and keep it only if it beats the baseline.
    if (outcome.ok) {
      const candidate = await this.score(source, outcome.preview.files, inputs);
      if (candidate > baseline) {
        if (this.config.writeback) this.workspace.writeBack(source, outcome.preview.files);
        this.reporter.iterationDecided({ iter: 1, total: 1, decision: "accepted", objective: candidate, changes: outcome.preview.changes, rationale: outcome.rationale });
        return this.result(source, 1, outcome.preview.files, "accepted", startedAt);
      }
    }

    // 4. Otherwise keep the original.
    this.reporter.iterationDecided({ iter: 1, total: 1, decision: "rejected", objective: baseline });
    return this.result(source, "baseline", fileMap(source), "rejected", startedAt);
  }

  /** Apply a candidate file set into a fresh workspace, run + grade it; return its objective (0 if a gate fails). */
  private async score(source: OptimizeTargetSet, files: Record<string, string>, inputs: Input[]): Promise<number> {
    const ws = this.fork(source.baseDir);
    this.workspace.applyFiles(ws, files);
    const scorecard = await this.evaluate(ws, source.entryFile, inputs);
    return scorecard.gatesPassed() ? scorecard.objective() : 0;
  }

  private result(
    source: OptimizeTargetSet,
    championIter: number | "baseline",
    championFiles: Record<string, string>,
    decision: "accepted" | "rejected",
    startedAt: number,
  ): OptimizeResult {
    const result = this.buildPointwiseResult({ championIter, championFiles, attempts: [{ iter: 1, decision }] });
    this.reporter.runFinished({ result, initialTargets: source.targets, finalTargets: source.targets, durationMs: Date.now() - startedAt });
    return result;
  }
}

/** Map the optimize inputs to the EvalTask shape the mutator prompt expects (it reads each task's goal). */
function inputsAsTasks(inputs: Input[]): EvalTask[] {
  return inputs.map((input, index) => ({
    task_id: input.id ?? `input-${index}`,
    goal: String(input.metadata?.goal ?? ""),
    args: input.args,
  }));
}
