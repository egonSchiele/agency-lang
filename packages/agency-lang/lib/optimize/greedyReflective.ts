import * as path from "path";

import { resolveEvalRunTarget } from "@/cli/eval/run.js";
import type { EvalTask } from "@/eval/runTypes.js";

import { BaseOptimizer, type BaseOptimizerDeps } from "./baseOptimizer.js";
import { proposeMutation, type ProposeMutationArgs } from "./mutator.js";
import type { Scorecard } from "./grading/scorecard.js";
import type { Input } from "./grading/types.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import { OptimizeSourceMutator, type OptimizeMutationOperation, type OptimizeMutationPreview } from "./sourceMutator.js";
import { discoverOptimizeTargets, type OptimizeTargetSet } from "./targets.js";
import type { IterationResult, MutationProposal, OptimizeResult } from "./types.js";
import type { Workspace } from "./workspace.js";

/** Test seams: inject discovery / proposal / preview so the loop can run without real LLM or AST work. */
export type GreedyDeps = BaseOptimizerDeps & {
  discover?: (agentFile: string) => OptimizeTargetSet;
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
type Attempt = { iter: number; decision: Decision; rationale: string; objective?: number; candidate?: Candidate };

/** Champion–challenger hill-climb with pointwise grading (replaces the pairwise judge). */
export class GreedyReflective extends BaseOptimizer {
  readonly name = "greedy";
  constructor(config: BaseOptimizerConfig, private readonly greedyDeps: GreedyDeps = {}) {
    super(config, greedyDeps);
  }

  async optimize(target: OptimizeTarget): Promise<OptimizeResult> {
    const agentFile = resolveEvalRunTarget(target.agent).agentFile;
    const source = (this.greedyDeps.discover ?? discoverOptimizeTargets)(agentFile);
    if (source.targets.length === 0) {
      throw new Error(`No optimize targets found in ${agentFile}. Mark a declaration with the optimize modifier.`);
    }

    const baseline = await this.makeCandidate("baseline", this.fork(source.baseDir), source, target.inputs);
    this.requireBaselineGatesPass(baseline);

    const attempts = await this.hillClimb(baseline, target.inputs);
    const champion = lastAccepted(attempts)?.candidate ?? baseline;

    if (this.config.writeback && champion.iter !== "baseline") {
      this.workspace.writeBack(source, champion.files);
    }
    return this.buildResult(champion, attempts);
  }

  /** The one place the champion is threaded across iterations. */
  private async hillClimb(baseline: Candidate, inputs: Input[]): Promise<Attempt[]> {
    const attempts: Attempt[] = [];
    let champion = baseline;
    for (let iter = 1; iter <= this.config.iterations; iter += 1) {
      const attempt = await this.attempt(champion, inputs, iter, attempts);
      if (attempt.decision === "accepted" && attempt.candidate) champion = attempt.candidate;
      attempts.push(attempt);
    }
    return attempts;
  }

  /** Propose → apply → evaluate one candidate, deciding accept/reject against the champion. */
  private async attempt(champion: Candidate, inputs: Input[], iter: number, history: Attempt[]): Promise<Attempt> {
    const proposal = await (this.greedyDeps.propose ?? proposeMutation)({
      config: this.config.config,
      targets: champion.targetSet.targets,
      tasks: inputsAsTasks(inputs),
      history: renderHistory(history),
      model: this.config.mutatorModel,
    });
    const preview = (this.greedyDeps.preview ?? defaultPreview)(champion.targetSet, proposal.operations);
    if (preview.diagnostics.length > 0) {
      return { iter, decision: "validation-failed", rationale: proposal.rationale };
    }
    const candidate = await this.makeCandidate(iter, this.fork(champion.ws.dir), preview.targetSet, inputs, preview.files);
    const decision: Decision = this.beats(candidate, champion) ? "accepted" : "rejected";
    return { iter, decision, rationale: proposal.rationale, objective: candidate.scorecard.objective(), candidate };
  }

  /** Apply the candidate's file set (if any) into its forked workspace and grade it. */
  private async makeCandidate(
    iter: number | "baseline",
    ws: Workspace,
    targetSet: OptimizeTargetSet,
    inputs: Input[],
    files?: Record<string, string>,
  ): Promise<Candidate> {
    if (files) this.workspace.applyFiles(ws, files);
    const scorecard = await this.evaluate(ws, targetSet.entryFile, inputs);
    return { iter, ws, scorecard, targetSet, files: files ?? fileMap(targetSet) };
  }

  /** Greedy's acceptance policy: pass every gate AND beat the champion's objective. */
  private beats(candidate: Candidate, champion: Candidate): boolean {
    return candidate.scorecard.gatesPassed() && candidate.scorecard.objective() > champion.scorecard.objective();
  }

  private requireBaselineGatesPass(baseline: Candidate): void {
    if (baseline.scorecard.gatesPassed()) return;
    const failed = failingGraders(baseline.scorecard);
    throw new Error(
      `Baseline fails must-pass grader(s) [${failed.join(", ")}] — fix the program or those graders before optimizing.`,
    );
  }

  private buildResult(champion: Candidate, attempts: Attempt[]): OptimizeResult {
    const count = (decision: Decision): number => attempts.filter((a) => a.decision === decision).length;
    const baselineIteration: IterationResult = { iter: 0, decision: "baseline", winsA: 0, winsB: 0, ties: 0 };
    return {
      runId: this.config.runId,
      runDir: path.join(this.config.runsDir, this.config.runId),
      championIter: champion.iter,
      championFiles: champion.files,
      acceptedCount: count("accepted"),
      rejectedCount: count("rejected"),
      validationFailedCount: count("validation-failed"),
      iterations: [baselineIteration, ...attempts.map((a) => ({ iter: a.iter, decision: a.decision, winsA: 0, winsB: 0, ties: 0 }))],
    };
  }
}

function defaultPreview(targetSet: OptimizeTargetSet, operations: OptimizeMutationOperation[]): OptimizeMutationPreview {
  return new OptimizeSourceMutator({ targetSet }).preview(operations);
}

function fileMap(source: OptimizeTargetSet): Record<string, string> {
  return Object.fromEntries(Object.entries(source.files).map(([rel, sf]) => [rel, sf.source]));
}

function inputsAsTasks(inputs: Input[]): EvalTask[] {
  return inputs.map((input) => ({ task_id: input.id ?? "input", goal: String(input.metadata?.goal ?? ""), args: input.args }));
}

function lastAccepted(attempts: Attempt[]): Attempt | undefined {
  return [...attempts].reverse().find((a) => a.decision === "accepted");
}

/** Names of the must-pass graders that failed on at least one input. */
function failingGraders(scorecard: Scorecard): string[] {
  const names = scorecard.perInput.flatMap((input) =>
    input.grades.filter((g) => g.grader.mustPass() && !g.grader.passes(g.grade)).map((g) => g.grader.name()),
  );
  return names.filter((name, i) => names.indexOf(name) === i);
}

function renderHistory(attempts: Attempt[]): string {
  if (attempts.length === 0) return "";
  return attempts
    .map((a) => `- iter ${a.iter} [${a.decision}] objective=${a.objective?.toFixed(3) ?? "n/a"}: ${a.rationale}`)
    .join("\n");
}
