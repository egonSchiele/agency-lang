// A user-style custom optimizer, loaded via `--optimizer ./customOptimizer.ts`.
// Mirrors lib/optimize/optimizers/example.ts but imports from the public API,
// exactly as a user outside the repo would, and loops the reflective round
// `this.config.iterations` times (driven by the CLI's --iterations flag) so a
// single bad LLM proposal doesn't sink the run. Each round: score the current
// champion, ask the built-in mutator for one new set of target values, and
// keep it if it beats the champion. Exercises the --optimizer loader
// end-to-end and stays competitive with the built-in greedy axis.
import {
  BaseOptimizer,
  defaultPreview,
  fileMap,
  proposeMutation,
  type BaseOptimizerConfig,
  type Input,
  type OptimizeResult,
  type OptimizeTargetSet,
  type Scorecard,
} from "agency-lang/optimize";

type Candidate = {
  iter: number | "baseline";
  files: Record<string, string>;
  targetSet: OptimizeTargetSet;
  scorecard: Scorecard;
};

class CustomEfficacyOptimizer extends BaseOptimizer {
  readonly name = "custom-efficacy";

  /** Fork the workspace, apply `files`, grade — the unit every round produces.
   *  `targetSet` must reflect this candidate's actual targets (baseline's for
   *  the baseline candidate, `outcome.preview.targetSet` for an accepted
   *  mutation), so subsequent iterations mutate relative to the champion and
   *  `finalTargets` in the reporter accurately describes the champion. */
  private async makeCandidate(
    iter: number | "baseline",
    files: Record<string, string>,
    targetSet: OptimizeTargetSet,
    inputs: Input[],
  ): Promise<Candidate> {
    return { iter, files, targetSet, scorecard: await this.scoreFiles(targetSet, files, inputs) };
  }

  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
    const startedAt = Date.now();
    const total = Math.max(1, this.config.iterations);
    this.reporter.runStarted({
      optimizer: this.name,
      runId: this.config.runId,
      targets: source.targets,
      inputCount: inputs.length,
      iterations: total,
    });

    const baseline = await this.makeCandidate("baseline", fileMap(source), source, inputs);
    this.reporter.baselineScored({ objective: baseline.scorecard.gatedObjective() });

    const candidates: Candidate[] = [baseline];
    const attempts: { iter: number; decision: "accepted" | "rejected" }[] = [];
    let champion: Candidate = baseline;

    for (let iter = 1; iter <= total; iter++) {
      const outcome = await this.proposeValidMutation(
        (diagnostics) =>
          proposeMutation({
            config: this.config.config,
            // Feed the *champion's* current targets to the mutator so each
            // iteration refines the running champion, not the baseline.
            targets: champion.targetSet.targets,
            inputs,
            history: "",
            model: this.config.mutatorModel,
            diagnostics,
          }),
        (operations) => defaultPreview(champion.targetSet, operations),
      );

      const candidate = outcome.ok
        ? await this.makeCandidate(iter, outcome.preview.files, outcome.preview.targetSet, inputs)
        : undefined;
      const beats = candidate !== undefined && candidate.scorecard.gatedObjective() > champion.scorecard.gatedObjective();
      const next = beats ? candidate! : champion;
      const decision: "accepted" | "rejected" = beats ? "accepted" : "rejected";

      attempts.push({ iter, decision });
      this.reporter.iterationDecided({ iter, total, decision, objective: next.scorecard.gatedObjective() });

      if (beats && candidate) {
        candidates.push(candidate);
        champion = candidate;
      }
    }

    return this.finishPointwise(source, candidates, champion, attempts, startedAt);
  }
}

export default (config: BaseOptimizerConfig) => new CustomEfficacyOptimizer(config);
