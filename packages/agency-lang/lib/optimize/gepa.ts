import { resolveEvalRunTarget } from "@/cli/eval/run.js";

import { BaseOptimizer, type BaseOptimizerDeps } from "./baseOptimizer.js";
import { CandidatePool, type PoolCandidate } from "./candidatePool.js";
import { renderReflectionFeedback } from "./gepaFeedback.js";
import { proposeReflective, type ReflectionSections } from "./gepaReflect.js";
import type { AgencyRunner } from "./grading/agencyRunner.js";
import { inputObjective, type InputGrades, type Scorecard } from "./grading/scorecard.js";
import type { Input } from "./grading/types.js";
import { renderTargetsSection } from "./mutator.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import { makeRng, sampleWithoutReplacement, type Rng } from "./rng.js";
import { defaultPreview, type OptimizeMutationOperation, type OptimizeMutationPreview } from "./sourceMutator.js";
import { discoverOptimizeTargets, fileMap, type OptimizeTarget as OptimizeTargetDecl, type OptimizeTargetSet } from "./targets.js";
import type { MutationProposal, OptimizeDecision, OptimizeResult } from "./types.js";
import type { Workspace } from "./workspace.js";

export type GepaConfig = BaseOptimizerConfig & {
  minibatch: number;
  paretoSet?: Input[];
  moduleSelection?: "round-robin" | "all";
};

export type GepaDeps = BaseOptimizerDeps & {
  discover?: (agentFile: string) => OptimizeTargetSet;
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
type Attempt = { iter: number; decision: Exclude<OptimizeDecision, "baseline">; rationale: string; candidate?: Candidate };

/** GEPA: reflective evolution with a Pareto candidate pool and minibatched promotion. */
export class Gepa extends BaseOptimizer {
  readonly name = "gepa";
  private readonly gepaConfig: GepaConfig;

  constructor(config: GepaConfig, private readonly gepaDeps: GepaDeps = {}) {
    super(config, gepaDeps);
    this.gepaConfig = config;
  }

  async optimize(target: OptimizeTarget): Promise<OptimizeResult> {
    const agentFile = resolveEvalRunTarget(target.agent).agentFile;
    const source = (this.gepaDeps.discover ?? discoverOptimizeTargets)(agentFile);
    if (source.targets.length === 0) {
      throw new Error(`No optimize targets found in ${agentFile}. Mark a declaration with the optimize modifier.`);
    }
    const paretoInputs = this.gepaConfig.paretoSet ?? target.inputs;
    const rng = makeRng(this.config.seed ?? 0);

    const baseline = await this.makeCandidate("baseline", this.fork(source.baseDir), source, paretoInputs, fileMap(source));
    this.requireBaselineGatesPass(baseline.scorecard);

    const pool = new CandidatePool<Candidate>([toPoolCandidate(baseline)]);
    const attempts = await this.evolve(pool, target.inputs, paretoInputs, rng);

    const champion = pool.best().value;
    if (this.config.writeback && champion.iter !== "baseline") this.workspace.writeBack(source, champion.files);
    return this.buildPointwiseResult({ championIter: champion.iter, championFiles: champion.files, attempts });
  }

  /** Run the optimization loop, threading the pool. */
  private async evolve(pool: CandidatePool<Candidate>, inputs: Input[], paretoInputs: Input[], rng: Rng): Promise<Attempt[]> {
    const attempts: Attempt[] = [];
    for (let iter = 1; iter <= this.config.iterations; iter += 1) {
      const parent = pool.sampleParent(rng).value;
      const minibatch = sampleWithoutReplacement(inputs, this.gepaConfig.minibatch, rng);
      const attempt = await this.attempt(parent, minibatch, paretoInputs, iter);
      if (attempt.decision === "accepted" && attempt.candidate) pool.add(toPoolCandidate(attempt.candidate));
      attempts.push(attempt);
    }
    return attempts;
  }

  /** One reflective iteration: propose → validate → minibatch filter → (maybe) full eval. */
  private async attempt(parent: Candidate, minibatch: Input[], paretoInputs: Input[], iter: number): Promise<Attempt> {
    const proposal = await this.proposeFrom(parent, minibatch, iter);
    const preview = (this.gepaDeps.preview ?? defaultPreview)(parent.targetSet, proposal.operations);
    if (preview.diagnostics.length > 0) return { iter, decision: "validation-failed", rationale: proposal.rationale };

    const childWs = this.fork(parent.ws.dir);
    this.workspace.applyFiles(childWs, preview.files);
    const entry = preview.targetSet.entryFile;
    const childMini = await this.evaluate(childWs, entry, minibatch);
    const parentMini = await this.evaluate(parent.ws, parent.targetSet.entryFile, minibatch);   // cache hits
    if (!(childMini.gatesPassed() && childMini.objective() > parentMini.objective())) {
      return { iter, decision: "rejected", rationale: proposal.rationale };
    }
    const full = await this.evaluate(childWs, entry, paretoInputs);
    const candidate: Candidate = { iter, ws: childWs, scorecard: full, targetSet: preview.targetSet, files: preview.files };
    return { iter, decision: "accepted", rationale: proposal.rationale, candidate };
  }

  /** Build the reflection context (selected target + weakest-input traces) and ask the proposer. */
  private proposeFrom(parent: Candidate, minibatch: Input[], iter: number): Promise<MutationProposal> {
    const selected = this.selectTargets(parent.targetSet.targets, iter);
    const sections: ReflectionSections = {
      targets: renderTargetsSection(selected),
      feedback: renderReflectionFeedback(this.focus(parent, minibatch)),
      history: "",
    };
    return (this.gepaDeps.propose ?? proposeReflective)(this.agencyRunner, sections);
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
