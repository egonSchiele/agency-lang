import { BaseOptimizer, type BaseOptimizerDeps } from "../baseOptimizer.js";
import { CandidatePool, type PoolCandidate } from "../candidatePool.js";
import { renderReflectionFeedback } from "../gepaFeedback.js";
import { proposeReflective, type ReflectionSections } from "../gepaReflect.js";
import type { AgencyRunner } from "../grading/agencyRunner.js";
import { inputObjective, type InputGrades, type Scorecard } from "../grading/scorecard.js";
import type { Input } from "../grading/types.js";
import { renderTargetsSection } from "../mutator.js";
import type { BaseOptimizerConfig } from "../optimizer.js";
import { formatDiagnostics } from "../reporter.js";
import { makeRng, sampleWithoutReplacement, type Rng } from "../rng.js";
import { defaultPreview, type OptimizeAppliedChange, type OptimizeMutationDiagnostic, type OptimizeMutationOperation, type OptimizeMutationPreview } from "../sourceMutator.js";
import { fileMap, type OptimizeTarget as OptimizeTargetDecl, type OptimizeTargetSet } from "../targets.js";
import type { MutationProposal, OptimizeDecision, OptimizeResult } from "../types.js";
import type { Workspace } from "../workspace.js";

export type GepaConfig = BaseOptimizerConfig & {
  minibatch: number;
  paretoSet?: Input[];
  moduleSelection?: "round-robin" | "all";
};

export type GepaDeps = BaseOptimizerDeps & {
  propose?: (runAgency: AgencyRunner, sections: ReflectionSections) => Promise<MutationProposal>;
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

/** The immutable record of one iteration. */
type Attempt = {
  iter: number;
  decision: Exclude<OptimizeDecision, "baseline">;
  rationale: string;
  objective?: number;
  changes?: OptimizeAppliedChange[];
  diagnostics?: OptimizeMutationDiagnostic[];
  candidate?: Candidate;
};

/** Why an iteration ended up the way it did: validation diagnostics, else the proposal rationale. */
function attemptDetail(a: Attempt): string | undefined {
  if (a.diagnostics?.length) return formatDiagnostics(a.diagnostics);
  return a.rationale || undefined;
}

/** GEPA: reflective evolution with a Pareto candidate pool and minibatched promotion. */
export class Gepa extends BaseOptimizer {
  readonly name = "gepa";
  private readonly gepaConfig: GepaConfig;

  constructor(config: GepaConfig, private readonly gepaDeps: GepaDeps = {}) {
    super(config, gepaDeps);
    if (!Number.isInteger(config.minibatch) || config.minibatch < 1) {
      throw new Error(`GEPA requires a positive integer minibatch size; got ${String(config.minibatch)}.`);
    }
    this.gepaConfig = config;
  }

  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
    if (this.validationInputs.length > 0) {
      this.reporter.note(`validation set provided, but ${this.name} selects the champion on the training objective`);
    }
    const paretoInputs = this.gepaConfig.paretoSet ?? inputs;
    const rng = makeRng(this.config.seed ?? 0);

    const startedAt = Date.now();
    this.reporter.runStarted({
      optimizer: this.name, runId: this.config.runId,
      targets: source.targets, inputCount: inputs.length, iterations: this.config.iterations,
    });
    const baseline = await this.makeCandidate("baseline", this.fork(source.baseDir), source, paretoInputs, fileMap(source));
    this.requireBaselineGatesPass(baseline.scorecard);
    this.reporter.baselineScored({ objective: baseline.scorecard.objective() });

    if (this.isMaxObjective(baseline.scorecard)) {
      this.reporter.note("baseline already scores the maximum objective (1.000) — nothing to optimize");
      return this.finish(source, baseline, [], startedAt);
    }

    const pool = new CandidatePool<Candidate>([toPoolCandidate(baseline)]);
    const attempts = await this.evolve(pool, inputs, paretoInputs, rng);
    return this.finish(source, pool.best().value, attempts, startedAt);
  }

  /** Write back the champion (if enabled), build the result, and report completion. */
  private finish(source: OptimizeTargetSet, champion: Candidate, attempts: Attempt[], startedAt: number): OptimizeResult {
    if (this.config.writeback && champion.iter !== "baseline") this.workspace.writeBack(source, champion.files);
    const result = this.buildPointwiseResult({
      championIter: champion.iter, championFiles: champion.files,
      attempts: attempts.map((a) => ({ iter: a.iter, decision: a.decision, detail: attemptDetail(a) })),
    });
    this.reporter.runFinished({
      result, initialTargets: source.targets, finalTargets: champion.targetSet.targets, durationMs: Date.now() - startedAt,
    });
    return result;
  }

  /** Run the optimization loop, threading the pool. */
  private async evolve(pool: CandidatePool<Candidate>, inputs: Input[], paretoInputs: Input[], rng: Rng): Promise<Attempt[]> {
    const attempts: Attempt[] = [];
    for (let iter = 1; iter <= this.config.iterations; iter += 1) {
      const startedAt = Date.now();
      const parent = pool.sampleParent(rng).value;
      const parentLabel = parent.iter === "baseline" ? "baseline" : `iter ${parent.iter}`;
      this.reporter.note(`parent: ${parentLabel} (objective ${parent.scorecard.objective().toFixed(3)}, pool size ${pool.size()})`);
      const minibatch = sampleWithoutReplacement(inputs, this.gepaConfig.minibatch, rng);
      const attempt = await this.attempt(parent, minibatch, paretoInputs, iter);
      if (attempt.decision === "accepted" && attempt.candidate) pool.add(toPoolCandidate(attempt.candidate));
      attempts.push(attempt);
      this.reporter.iterationDecided({
        iter, total: this.config.iterations,
        decision: attempt.decision, objective: attempt.objective, rationale: attempt.rationale,
        changes: attempt.changes, diagnostics: attempt.diagnostics, durationMs: Date.now() - startedAt,
      });
      if (this.isMaxObjective(pool.best().value.scorecard)) {
        this.reporter.note("reached the maximum objective (1.000) — stopping early");
        break;
      }
    }
    return attempts;
  }

  /** One reflective iteration: propose → validate → minibatch filter → (maybe) full eval. */
  private async attempt(parent: Candidate, minibatch: Input[], paretoInputs: Input[], iter: number): Promise<Attempt> {
    const selected = this.selectTargets(parent.targetSet.targets, iter);
    const feedback = renderReflectionFeedback(this.focus(parent, minibatch));
    const outcome = await this.proposeValidMutation(
      (diagnostics) => (this.gepaDeps.propose ?? proposeReflective)(this.agencyRunner, {
        targets: renderTargetsSection(selected),
        feedback,
        // Feed validation errors from the previous attempt back so the model corrects itself.
        history: diagnostics.length === 0 ? "" : `Your previous proposal was rejected:\n${formatDiagnostics(diagnostics)}\nFix these and keep every interpolation placeholder.`,
      }),
      (operations) => (this.gepaDeps.preview ?? defaultPreview)(parent.targetSet, operations),
    );
    if (!outcome.ok) return { iter, decision: "validation-failed", rationale: outcome.rationale, diagnostics: outcome.diagnostics };
    const preview = outcome.preview;

    const childWs = this.fork(parent.ws.dir);
    this.workspace.applyFiles(childWs, preview.files);
    const entry = preview.targetSet.entryFile;
    const childMini = await this.evaluate(childWs, entry, minibatch);
    const parentMini = await this.evaluate(parent.ws, parent.targetSet.entryFile, minibatch);   // cache hits
    if (!(childMini.gatesPassed() && childMini.objective() > parentMini.objective())) {
      return { iter, decision: "rejected", rationale: outcome.rationale, objective: childMini.objective(), changes: preview.changes };
    }
    const full = await this.evaluate(childWs, entry, paretoInputs);
    const candidate: Candidate = { iter, ws: childWs, scorecard: full, targetSet: preview.targetSet, files: preview.files };
    return { iter, decision: "accepted", rationale: outcome.rationale, objective: full.objective(), changes: preview.changes, candidate };
  }

  /** Round-robin one target per iteration (SelectModule); `"all"` shows every target. */
  private selectTargets(targets: OptimizeTargetDecl[], iter: number): OptimizeTargetDecl[] {
    if (this.gepaConfig.moduleSelection === "all") return targets;
    return [targets[(iter - 1) % targets.length]];
  }

  /** The parent's weakest minibatch inputs (by reference), weakest first; falls back to all. */
  private focus(parent: Candidate, minibatch: Input[]): InputGrades[] {
    const batch = new Set(minibatch);
    const matched = parent.scorecard.perInput.filter((pi) => batch.has(pi.input));
    const focus = matched.length > 0 ? matched : [...parent.scorecard.perInput];
    return [...focus]
      .sort((a, b) => inputObjective(a.grades) - inputObjective(b.grades))
      .slice(0, this.gepaConfig.minibatch);
  }

  /** Apply files into a workspace and grade on `inputs`. */
  private async makeCandidate(
    iter: number | "baseline", ws: Workspace, targetSet: OptimizeTargetSet, inputs: Input[], files: Record<string, string>,
  ): Promise<Candidate> {
    this.workspace.applyFiles(ws, files);
    const scorecard = await this.evaluate(ws, targetSet.entryFile, inputs);
    return { iter, ws, scorecard, targetSet, files };
  }
}

function toPoolCandidate(c: Candidate): PoolCandidate<Candidate> {
  return { value: c, inputScores: c.scorecard.inputScores(), objective: c.scorecard.objective() };
}
