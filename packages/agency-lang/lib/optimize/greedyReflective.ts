import * as fs from "fs";

import { resolveEvalRunTarget } from "@/cli/eval/run.js";
import type { EvalTask } from "@/eval/runTypes.js";

import { BaseOptimizer, type BaseOptimizerDeps } from "./baseOptimizer.js";
import { proposeMutation, type ProposeMutationArgs } from "./mutator.js";
import type { Scorecard } from "./grading/scorecard.js";
import type { Input } from "./grading/types.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import { OptimizeSourceMutator, type OptimizeMutationOperation, type OptimizeMutationPreview } from "./sourceMutator.js";
import { discoverOptimizeTargets, sha256Text, type OptimizeTargetSet } from "./targets.js";
import type { IterationResult, MutationProposal, OptimizeResult } from "./types.js";
import type { Workspace } from "./workspace.js";

/** Test seams: inject discovery / proposal / preview so the loop can run without real LLM or AST work. */
export type GreedyDeps = BaseOptimizerDeps & {
  discover?: (agentFile: string) => OptimizeTargetSet;
  propose?: (args: ProposeMutationArgs) => Promise<MutationProposal>;
  preview?: (targetSet: OptimizeTargetSet, operations: OptimizeMutationOperation[]) => OptimizeMutationPreview;
};

type Champion = {
  iter: number | "baseline";
  ws: Workspace;
  scorecard: Scorecard;
  targetSet: OptimizeTargetSet;
  files: Record<string, string>;
};

type HistoryEntry = { iter: number; decision: string; rationale: string; objective: number };

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
    const entry = source.entryFile;

    const baselineWs = this.fork(source.baseDir);
    const baselineScore = await this.evaluate(baselineWs, entry, target.inputs);
    if (!baselineScore.gatesPassed()) {
      throw new Error("Baseline fails a must-pass grader — fix the program or graders before optimizing.");
    }

    let champion: Champion = { iter: "baseline", ws: baselineWs, scorecard: baselineScore, targetSet: source, files: fileMap(source) };
    const history: HistoryEntry[] = [];
    const iterations: IterationResult[] = [{ iter: 0, decision: "baseline", winsA: 0, winsB: 0, ties: 0 }];
    let accepted = 0; let rejected = 0; let validationFailed = 0;

    await this.eachIteration(async (iter) => {
      const proposal = await (this.greedyDeps.propose ?? proposeMutation)({
        config: this.config.config,
        targets: champion.targetSet.targets,
        tasks: inputsAsTasks(target.inputs),
        history: renderHistory(history),
        model: this.config.mutatorModel,
      });
      const preview = (this.greedyDeps.preview ?? defaultPreview)(champion.targetSet, proposal.operations);
      if (preview.diagnostics.length > 0) {
        validationFailed += 1;
        iterations.push({ iter, decision: "validation-failed", winsA: 0, winsB: 0, ties: 0 });
        history.push({ iter, decision: "validation-failed", rationale: proposal.rationale, objective: NaN });
        return;
      }

      const candidate = this.fork(champion.ws.dir);
      this.workspace.applyFiles(candidate, preview.files);
      const score = await this.evaluate(candidate, entry, target.inputs);
      const wins = score.gatesPassed() && score.objective() > champion.scorecard.objective();
      iterations.push({ iter, decision: wins ? "accepted" : "rejected", winsA: 0, winsB: 0, ties: 0 });
      history.push({ iter, decision: wins ? "accepted" : "rejected", rationale: proposal.rationale, objective: score.objective() });
      if (wins) {
        champion = { iter, ws: candidate, scorecard: score, targetSet: preview.targetSet, files: preview.files };
        accepted += 1;
      } else {
        rejected += 1;
      }
    });

    this.writeBack(source, champion);
    return {
      runId: this.config.runId,
      runDir: this.config.runsDir,
      championIter: champion.iter,
      championFiles: champion.files,
      acceptedCount: accepted,
      rejectedCount: rejected,
      validationFailedCount: validationFailed,
      iterations,
    };
  }

  /** Write the champion file set back to the original sources, sha-checked (as PR #283). */
  private writeBack(source: OptimizeTargetSet, champion: Champion): void {
    if (!this.config.writeback || champion.iter === "baseline") return;
    for (const sf of Object.values(source.files)) {
      if (sha256Text(fs.readFileSync(sf.absoluteFile, "utf8")) !== sf.sha256) {
        throw new Error(`Source file ${sf.absoluteFile} was modified externally; writeback aborted.`);
      }
    }
    for (const [rel, contents] of Object.entries(champion.files)) {
      if (contents !== source.files[rel]?.source) fs.writeFileSync(source.files[rel].absoluteFile, contents);
    }
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

function renderHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return "";
  return history
    .map((h) => `- iter ${h.iter} [${h.decision}] objective=${Number.isNaN(h.objective) ? "n/a" : h.objective.toFixed(3)}: ${h.rationale}`)
    .join("\n");
}
