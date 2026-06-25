import { BaseOptimizer, type BaseOptimizerDeps } from "../baseOptimizer.js";
import type { Scorecard } from "../grading/scorecard.js";
import type { Input } from "../grading/types.js";
import { proposeMutation, type ProposeMutationArgs } from "../mutator.js";
import type { BaseOptimizerConfig } from "../optimizer.js";
import { defaultPreview, type OptimizeMutationOperation, type OptimizeMutationPreview } from "../sourceMutator.js";
import { fileMap, type OptimizeTargetSet } from "../targets.js";
import type { MutationProposal, OptimizeResult } from "../types.js";

/** A scored point in the search: its file set + the Scorecard it earned. */
type Candidate = {
  iter: number | "baseline";
  files: Record<string, string>;
  scorecard: Scorecard;
  targetSet: OptimizeTargetSet;
};

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
 *   - `this.finishPointwise(source, candidates, trainChampion, attempts, startedAt)` —
 *     pick the writeback champion (by validation when configured), write it back,
 *     and build the OptimizeResult with train/validation objectives + breakdown
 *   - `this.reporter` — progress output (silent unless the CLI sets verbosity)
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
    const baseline = await this.makeCandidate("baseline", fileMap(source), source, inputs);
    this.reporter.baselineScored({ objective: baseline.scorecard.gatedObjective() });

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

    // 3. Score the proposal (if any) and decide acceptance on the training objective.
    const candidate = outcome.ok
      ? await this.makeCandidate(1, outcome.preview.files, source, inputs)
      : undefined;
    const beatsBaseline = candidate !== undefined && candidate.scorecard.gatedObjective() > baseline.scorecard.gatedObjective();
    const trainChampion = beatsBaseline ? candidate : baseline;
    const decision = beatsBaseline ? "accepted" : "rejected";

    this.reporter.iterationDecided({
      iter: 1, total: 1, decision, objective: trainChampion.scorecard.gatedObjective(),
      ...(beatsBaseline && outcome.ok
        ? { changes: outcome.preview.changes, rationale: outcome.rationale }
        : {}),
    });

    // 4. Pick the writeback champion (by validation when configured), write it back,
    //    build the result with train/validation objectives + breakdown, and report.
    const candidates = beatsBaseline ? [baseline, candidate] : [baseline];
    return this.finishPointwise(source, candidates, trainChampion, [{ iter: 1, decision }], startedAt);
  }

  /** Apply a candidate file set into a fresh workspace, run + grade it. */
  private async makeCandidate(iter: number | "baseline", files: Record<string, string>, source: OptimizeTargetSet, inputs: Input[]): Promise<Candidate> {
    const scorecard = await this.scoreFiles(source, files, inputs);
    return { iter, files, scorecard, targetSet: source };
  }
}
