import { BaseOptimizer, type BaseOptimizerDeps } from "../baseOptimizer.js";
import { proposeMutation, type ProposeMutationArgs } from "../mutator.js";
import { renderReflectionFeedback } from "../reflectionFeedback.js";
import type { Scorecard } from "../grading/scorecard.js";
import type { Input } from "../grading/types.js";
import type { BaseOptimizerConfig } from "../optimizer.js";
import { formatDiagnostics } from "../reporter.js";
import { defaultPreview, type OptimizeAppliedChange, type OptimizeMutationDiagnostic, type OptimizeMutationOperation, type OptimizeMutationPreview } from "../sourceMutator.js";
import { fileMap, type OptimizeTargetSet } from "../targets.js";
import type { MutationProposal, OptimizeResult } from "../types.js";
import type { Workspace } from "../workspace.js";

/** Test seams: inject proposal / preview so the loop can run without real LLM or AST work.
 *  (Target discovery is injected via BaseOptimizerDeps.discover.) */
export type GreedyDeps = BaseOptimizerDeps & {
  propose?: (args: ProposeMutationArgs) => Promise<MutationProposal>;
  preview?: (targetSet: OptimizeTargetSet, operations: OptimizeMutationOperation[]) => OptimizeMutationPreview;
};

/** A fully-evaluated point in the search: a workspace + its grading + its target set/files. */
type Candidate = {
  iter: number | "baseline";
  ws: Workspace;
  scorecard: Scorecard;
  targetSet: OptimizeTargetSet;
  files: Record<string, string>;
};

type Decision = "accepted" | "rejected" | "validation-failed";
/** The immutable record of one iteration; all run stats are derived from these. */
type Attempt = { iter: number; decision: Decision; rationale: string; objective?: number; changes?: OptimizeAppliedChange[]; diagnostics?: OptimizeMutationDiagnostic[]; candidate?: Candidate };

/** Why an iteration ended up the way it did: validation diagnostics, else the proposal rationale. */
function attemptDetail(a: Attempt): string | undefined {
  if (a.diagnostics?.length) return formatDiagnostics(a.diagnostics);
  return a.rationale || undefined;
}

/** Champion–challenger hill-climb with pointwise grading (replaces the pairwise judge). */
export class GreedyReflective extends BaseOptimizer {
  readonly name = "greedy";
  constructor(config: BaseOptimizerConfig, private readonly greedyDeps: GreedyDeps = {}) {
    super(config, greedyDeps);
  }

  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
    const startedAt = Date.now();
    this.reporter.runStarted({
      optimizer: this.name, runId: this.config.runId,
      targets: source.targets, inputCount: inputs.length, iterations: this.config.iterations,
    });
    const baseline = await this.makeCandidate("baseline", this.fork(), source, inputs, fileMap(source));
    this.requireBaselineGatesPass(baseline.scorecard);
    this.reporter.baselineScored({ objective: baseline.scorecard.objective() });

    if (this.isMaxObjective(baseline.scorecard)) {
      this.reporter.note("baseline already scores the maximum objective (1.000) — nothing to optimize");
      return this.finishPointwise(source, [baseline], baseline, [], startedAt);
    }

    const attempts = await this.hillClimb(baseline, inputs);
    const accepted = attempts.filter((a) => a.decision === "accepted" && a.candidate).map((a) => a.candidate!);
    const trainChampion = accepted.length ? accepted[accepted.length - 1] : baseline;
    return this.finishPointwise(
      source, [baseline, ...accepted], trainChampion,
      attempts.map((a) => ({ iter: a.iter, decision: a.decision, detail: attemptDetail(a) })), startedAt,
    );
  }

  /** The one place the champion is threaded across iterations. */
  private async hillClimb(baseline: Candidate, inputs: Input[]): Promise<Attempt[]> {
    const attempts: Attempt[] = [];
    let champion = baseline;
    for (let iter = 1; iter <= this.config.iterations; iter += 1) {
      const startedAt = Date.now();
      const attempt = await this.attempt(champion, inputs, iter, attempts);
      if (attempt.decision === "accepted" && attempt.candidate) champion = attempt.candidate;
      attempts.push(attempt);
      this.reporter.iterationDecided({
        iter, total: this.config.iterations,
        decision: attempt.decision, objective: attempt.objective, rationale: attempt.rationale,
        changes: attempt.changes, diagnostics: attempt.diagnostics, durationMs: Date.now() - startedAt,
      });
      if (this.isMaxObjective(champion.scorecard)) {
        this.reporter.note("reached the maximum objective (1.000) — stopping early");
        break;
      }
    }
    return attempts;
  }

  /** Propose → apply → evaluate one candidate, deciding accept/reject against the champion. */
  private async attempt(champion: Candidate, inputs: Input[], iter: number, history: Attempt[]): Promise<Attempt> {
    const outcome = await this.proposeValidMutation(
      (diagnostics) => (this.greedyDeps.propose ?? proposeMutation)({
        config: this.config.config,
        targets: champion.targetSet.targets,
        inputs,
        feedback: renderReflectionFeedback(champion.scorecard.perInput),
        history: renderHistory(history),
        model: this.config.mutatorModel,
        diagnostics,
      }),
      (operations) => (this.greedyDeps.preview ?? defaultPreview)(champion.targetSet, operations),
    );
    if (!outcome.ok) {
      return { iter, decision: "validation-failed", rationale: outcome.rationale, diagnostics: outcome.diagnostics };
    }
    const preview = outcome.preview;
    const candidate = await this.makeCandidate(iter, this.fork(), preview.targetSet, inputs, preview.files);
    const decision: Decision = this.beats(candidate, champion) ? "accepted" : "rejected";
    return { iter, decision, rationale: outcome.rationale, objective: candidate.scorecard.objective(), changes: preview.changes, candidate };
  }

  /** Grade a candidate `files` map (the overlay) on `inputs`. */
  private async makeCandidate(
    iter: number | "baseline",
    ws: Workspace,
    targetSet: OptimizeTargetSet,
    inputs: Input[],
    files: Record<string, string>,
  ): Promise<Candidate> {
    const scorecard = await this.evaluate(ws, targetSet, files, inputs);
    return { iter, ws, scorecard, targetSet, files };
  }

  /** Greedy's acceptance policy: pass every gate AND beat the champion's objective. */
  private beats(candidate: Candidate, champion: Candidate): boolean {
    // TODO(gated-objective): collapse to `candidate.scorecard.gatedObjective() > champion.scorecard.gatedObjective()`
    // in the follow-up greedy/gepa sweep that the gate-aware Scorecard PR deferred. Equivalent
    // here since the champion always passes gates; moves with gepa's mirror site in one PR.
    return candidate.scorecard.gatesPassed() && candidate.scorecard.objective() > champion.scorecard.objective();
  }

}

function renderHistory(attempts: Attempt[]): string {
  if (attempts.length === 0) return "";
  return attempts
    .map((a) => `- iter ${a.iter} [${a.decision}] objective=${a.objective?.toFixed(3) ?? "n/a"}: ${a.rationale}`)
    .join("\n");
}
