import { BaseOptimizer, type BaseOptimizerDeps } from "../baseOptimizer.js";
import { breakdown } from "../gradeBreakdown.js";
import type { Scorecard } from "../grading/scorecard.js";
import type { Input } from "../grading/types.js";
import { proposeMutation, type ProposeMutationArgs } from "../mutator.js";
import type { BaseOptimizerConfig } from "../optimizer.js";
import { defaultPreview, type OptimizeMutationOperation, type OptimizeMutationPreview } from "../sourceMutator.js";
import { fileMap, type OptimizeTargetSet } from "../targets.js";
import type { MutationProposal, OptimizeResult } from "../types.js";

/** A scored point in the search: its file set + the Scorecard it earned. */
type Candidate = { iter: number | "baseline"; files: Record<string, string>; scorecard: Scorecard };

/** Gate-aware objective: a failed must-pass gate scores 0. */
function objectiveOf(scorecard: Scorecard): number {
  return scorecard.gatesPassed() ? scorecard.objective() : 0;
}

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
 * for one new set of values, score those, and keep the candidate if it beats the
 * baseline. The real optimizers (greedy, gepa) loop and search more cleverly, but
 * they all follow the same shape — fork → apply → evaluate → compare → report → return.
 *
 * Protected helpers available from BaseOptimizer:
 *   - `this.scoreFiles(source, files, inputs)` — fork + apply + grade, returns a Scorecard
 *   - `this.pickValidationChampion(source, candidates, trainChampion)` — choose the
 *     writeback champion by validation objective when a validation set exists
 *   - `this.reporter` — progress output (silent unless the CLI sets verbosity)
 *   - `this.buildPointwiseResult(...)` — package the OptimizeResult
 *   - `this.config` — graders, runId, writeback, mutatorModel, …
 * (and `breakdown(scorecard)` builds the per-input grade breakdown for the report.)
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
    const baseline = await this.candidate("baseline", fileMap(source), source, inputs);
    this.reporter.baselineScored({ objective: objectiveOf(baseline.scorecard) });

    // 2. Ask the built-in mutator for one new set of target values. proposeValidMutation
    //    (from BaseOptimizer) retries on validation errors and never throws on a bad response.
    const outcome = await this.proposeValidMutation(
      (diagnostics) => (this.exampleDeps.propose ?? proposeMutation)({
        config: this.config.config,
        targets: source.targets,
        inputs,
        history: "",
        model: this.config.mutatorModel,
        diagnostics,
      }),
      (operations) => (this.exampleDeps.preview ?? defaultPreview)(source, operations),
    );

    // 3. Keep the candidate only if it beats the baseline on the training objective.
    const candidates: Candidate[] = [baseline];
    let decision: "accepted" | "rejected" = "rejected";
    if (outcome.ok) {
      const candidate = await this.candidate(1, outcome.preview.files, source, inputs);
      if (objectiveOf(candidate.scorecard) > objectiveOf(baseline.scorecard)) {
        candidates.push(candidate);
        decision = "accepted";
        this.reporter.iterationDecided({ iter: 1, total: 1, decision: "accepted", objective: objectiveOf(candidate.scorecard), changes: outcome.preview.changes, rationale: outcome.rationale });
      }
    }
    if (decision === "rejected") {
      this.reporter.iterationDecided({ iter: 1, total: 1, decision: "rejected", objective: objectiveOf(baseline.scorecard) });
    }

    // 4. Pick the writeback champion by validation objective when a validation set
    //    exists (else the train winner), then package the result.
    const trainChampion = candidates[candidates.length - 1];
    const { champion, validationObjective } = await this.pickValidationChampion(source, candidates, trainChampion);
    if (this.config.writeback && champion.iter !== "baseline") this.workspace.writeBack(source, champion.files);
    const result = this.buildPointwiseResult({ championIter: champion.iter, championFiles: champion.files, attempts: [{ iter: 1, decision }] });
    result.trainObjective = objectiveOf(champion.scorecard);
    if (validationObjective !== undefined) result.validationObjective = validationObjective;
    result.championBreakdown = breakdown(champion.scorecard);
    this.reporter.runFinished({ result, initialTargets: source.targets, finalTargets: source.targets, durationMs: Date.now() - startedAt });
    return result;
  }

  /** Apply a candidate file set into a fresh workspace, run + grade it. */
  private async candidate(iter: number | "baseline", files: Record<string, string>, source: OptimizeTargetSet, inputs: Input[]): Promise<Candidate> {
    const scorecard = await this.scoreFiles(source, files, inputs);
    return { iter, files, scorecard };
  }
}
