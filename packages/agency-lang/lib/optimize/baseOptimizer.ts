import * as path from "path";

import { resolveEvalRunTarget } from "@/agentTarget.js";
import { runSuite } from "@/eval/run/runSuite.js";
import {
  gradeRun,
  makeGraderModuleCache,
  validateGraders,
  type GradingContext,
} from "@/eval/grading/gradeRun.js";

import { EvalCache } from "./evalCache.js";
import { breakdown } from "@/eval/grading/gradeBreakdown.js";
import { AgencyRunner } from "@/eval/grading/agencyRunner.js";
import { makeStatelogCostTailer } from "@/eval/run/costTail.js";
import { runDirPaths } from "@/runDirectory/runDir.js";
import type { BaseGrader } from "@/eval/grading/baseGrader.js";
import { Scorecard } from "@/eval/grading/scorecard.js";
import type { Test } from "@/eval/grading/types.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import { createPointwiseReporter, type PointwiseReporter } from "./reporter.js";
import type {
  OptimizeMutationDiagnostic,
  OptimizeMutationOperation,
  OptimizeMutationPreview,
} from "./sourceMutator.js";
import { discoverOptimizeTargets, type OptimizeTargetSet } from "./targets.js";
import type {
  IterationResult,
  MutationProposal,
  OptimizeCost,
  OptimizeDecision,
  OptimizeResult,
} from "./types.js";
import { WorkspaceManager, type CachePartition } from "./workspace.js";

/** Result of proposing a mutation: a clean preview, or the reason it couldn't be produced. */
export type MutationOutcome =
  | { ok: true; preview: OptimizeMutationPreview; rationale: string }
  | { ok: false; rationale: string; diagnostics: OptimizeMutationDiagnostic[] };

const MAX_PROPOSE_ATTEMPTS = 3;

/** A function that runs the agent for one input in a workspace and returns the
 *  RUN DIRECTORY it wrote (a suite of one). Receives the candidate's `source`
 *  (`baseDir`/`entryFile` live here) and `files` (the candidate's complete
 *  file map, used as the workdir overlay). Reading the run directory is
 *  grading's job, not this function's. */
export type RunInput = (
  ws: CachePartition,
  source: OptimizeTargetSet,
  files: Record<string, string>,
  input: Test,
  id: string,
) => Promise<string>;

export type BaseOptimizerDeps = {
  agencyRunner?: AgencyRunner;
  cache?: EvalCache;
  /** Override how the agent under test runs (tests inject a fake; default uses the eval-run path). */
  runInput?: RunInput;
  /** Override the progress reporter (tests inject one that captures lines). */
  reporter?: PointwiseReporter;
  /** Override target discovery (tests inject a fixed target set; default parses the agent file). */
  discover?: (agentFile: string) => OptimizeTargetSet;
};

export abstract class BaseOptimizer {
  protected readonly workspace: WorkspaceManager;
  protected readonly agencyRunner: AgencyRunner;
  /** Spend so far: the agent under test, and proposals. Judge spend is what
   *  the runner has accumulated beyond the proposals that went through it. */
  private agentCostUsd = 0;
  private mutatorCostUsd = 0;
  private mutatorViaRunnerUsd = 0;
  protected readonly cache: EvalCache;
  protected readonly reporter: PointwiseReporter;
  private readonly runInput: RunInput;
  private readonly discover: (agentFile: string) => OptimizeTargetSet;
  private runCounter = 0;
  /** Held-out validation inputs (empty when none); set in optimize(). */
  protected validationInputs: Test[] = [];

  constructor(
    protected readonly config: BaseOptimizerConfig,
    deps: BaseOptimizerDeps = {},
  ) {
    this.workspace = new WorkspaceManager();
    this.agencyRunner = deps.agencyRunner ?? new AgencyRunner(config.config);
    this.cache = deps.cache ?? new EvalCache();
    this.reporter = deps.reporter ?? createPointwiseReporter(config.verbosity ?? "silent");
    this.runInput =
      deps.runInput ??
      ((ws, source, files, input, id) => this.runInputViaEval(ws, source, files, input, id));
    this.discover = deps.discover ?? discoverOptimizeTargets;
  }

  abstract readonly name: string;

  /**
   * Resolve the agent file and discover its optimize targets once, then hand the
   * target set to the subclass. Every optimizer needs this preamble, so it lives
   * here — subclasses implement {@link optimizeTargets} and never touch discovery.
   */
  async optimize(target: OptimizeTarget): Promise<OptimizeResult> {
    const { agentFile, node } = resolveEvalRunTarget(target.agent);
    const source = { ...this.discover(agentFile), entryNode: node };
    if (source.targets.length === 0) {
      throw new Error(
        `No optimize targets found in ${agentFile}. Mark a declaration with the optimize modifier.`,
      );
    }
    this.validationInputs = target.validationInputs ?? [];
    await this.echoAndValidateGrading(target.inputs);
    return this.optimizeTargets(source, target.inputs);
  }

  /** Print the resolved grading setup and fail fast on a misconfigured grader
   *  before any agent run. An override set is validated against the first
   *  input; in snapshot mode each input's own grading module is loaded once
   *  and validated against its own test, so a broken graders.ts costs
   *  nothing but this preflight. */
  private async echoAndValidateGrading(inputs: Test[]): Promise<void> {
    const source = this.config.graders;
    // Validation inputs are graded too (champion selection), so a broken
    // grader there must also fail now, not after the search has run.
    const everyInput = [...inputs, ...this.validationInputs];
    if (source.kind === "override") {
      this.reporter.gradingSetup({
        graders: source.graders.map((g) => ({ name: g.name(), describe: g.describe() })),
        firstInput: inputs[0] ? { id: inputs[0].id ?? "(no id)", goal: inputs[0].goal } : undefined,
      });
      for (const input of [inputs[0], this.validationInputs[0]]) {
        if (input === undefined) continue;
        for (const grader of source.graders) {
          grader.validateInput(input);
        }
      }
      return;
    }
    this.reporter.gradingSetup({
      graders: [
        {
          name: "(per-test)",
          describe:
            "each input's own graders module and harness pairs; the goal judge for inputs with neither",
        },
      ],
      firstInput: inputs[0] ? { id: inputs[0].id ?? "(no id)", goal: inputs[0].goal } : undefined,
    });
    const cache = makeGraderModuleCache(this.config.config);
    for (const input of everyInput) {
      if (input.graders === undefined) continue;
      validateGraders(await cache(input.graders), input);
    }
  }

  /** Run the search over already-discovered targets. The one method an optimizer must implement. */
  protected abstract optimizeTargets(
    source: OptimizeTargetSet,
    inputs: Test[],
  ): Promise<OptimizeResult>;

  /**
   * A scorecard at the maximum objective can't be improved, so optimizers stop
   * early (or skip the loop when the baseline is already there). Assumes graders
   * are normalized to [0, 1]; binary-only setups score 0 and never trip this.
   */
  protected isMaxObjective(scorecard: Scorecard): boolean {
    return scorecard.objective() >= 1;
  }

  /**
   * Propose a mutation and validate it, with bounded retries. Two failure modes
   * are handled here so a single bad LLM response never aborts the run:
   *   - the proposer throws (malformed/unparseable response) — caught and retried;
   *   - the proposal is well-formed but fails validation (e.g. dropped an
   *     interpolation) — the diagnostics are fed back into the next `propose`
   *     call so the model can correct itself.
   * Returns the first clean preview, or `{ ok: false }` with the last failure's
   * reason after `maxAttempts`. Optimizers turn that into a failed iteration.
   */
  protected async proposeValidMutation(
    propose: (priorDiagnostics: OptimizeMutationDiagnostic[]) => Promise<MutationProposal>,
    preview: (operations: OptimizeMutationOperation[]) => OptimizeMutationPreview,
    maxAttempts = MAX_PROPOSE_ATTEMPTS,
  ): Promise<MutationOutcome> {
    let diagnostics: OptimizeMutationDiagnostic[] = [];
    let rationale = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let proposal: MutationProposal;
      const runnerBefore = this.agencyRunner.costUsd;
      try {
        proposal = await propose(diagnostics);
      } catch (error) {
        this.countProposalCost(runnerBefore, 0);
        rationale = `proposer returned a malformed response: ${error instanceof Error ? error.message : String(error)}`;
        diagnostics = [];
        continue;
      }
      this.countProposalCost(runnerBefore, proposal.costUsd ?? 0);
      rationale = proposal.rationale;
      const result = preview(proposal.operations);
      if (result.diagnostics.length === 0) return { ok: true, preview: result, rationale };
      diagnostics = result.diagnostics;
    }
    return { ok: false, rationale, diagnostics };
  }

  protected fork(): CachePartition {
    return this.workspace.fork();
  }

  /** Allocate a fresh cache-partition workspace and grade `files` on `inputs`.
   *  The canonical fresh-scoring primitive (used for validation). */
  protected async scoreFiles(
    source: OptimizeTargetSet,
    files: Record<string, string>,
    inputs: Test[],
  ): Promise<Scorecard> {
    const ws = this.fork();
    return this.evaluate(ws, source, files, inputs);
  }

  /** Choose the writeback champion among candidates: the one with the best
   *  validation objective when a validation set exists, else the given train
   *  champion. Scoring (the "how") is separated from the max selection (the
   *  "what"); shared by the pointwise optimizers so validation selection lives
   *  in one place. */
  protected async pickValidationChampion<
    C extends { files: Record<string, string>; scorecard: Scorecard },
  >(
    source: OptimizeTargetSet,
    candidates: C[],
    trainChampion: C,
  ): Promise<{
    champion: C;
    validationObjective?: number;
    scored: { candidate: C; objective: number }[];
  }> {
    if (this.validationInputs.length === 0) return { champion: trainChampion, scored: [] };
    // Always consider the train champion, even if a caller forgot to include it.
    const pool = candidates.includes(trainChampion) ? candidates : [trainChampion, ...candidates];
    const scored = await Promise.all(
      pool.map(async (candidate) => {
        const sc = await this.scoreFiles(source, candidate.files, this.validationInputs);
        return { candidate, objective: sc.gatesPassed() ? sc.objective() : 0 };
      }),
    );
    // pool always has the train champion, so reduce has at least one element.
    const winner = scored.reduce((best, s) => (s.objective > best.objective ? s : best));
    return { champion: winner.candidate, validationObjective: winner.objective, scored };
  }

  /** A proposal's spend: what it reported itself (greedy's mutator runs its
   *  own node) plus what it ran through the shared runner (gepa's proposer). */
  private countProposalCost(runnerBefore: number, reported: number): void {
    const viaRunner = this.agencyRunner.costUsd - runnerBefore;
    this.mutatorViaRunnerUsd += viaRunner;
    this.mutatorCostUsd += viaRunner + reported;
  }

  protected costSoFar(): OptimizeCost {
    const gradingUsd = this.agencyRunner.costUsd - this.mutatorViaRunnerUsd;
    return {
      agentUsd: this.agentCostUsd,
      gradingUsd,
      mutatorUsd: this.mutatorCostUsd,
      totalUsd: this.agentCostUsd + gradingUsd + this.mutatorCostUsd,
    };
  }

  /** The shared tail every pointwise optimizer runs: pick the writeback champion
   *  (by validation when configured), write it back, build the result with its
   *  train/validation objectives + grade breakdown, and report completion. An
   *  optimizer's job is just to produce the candidates and per-iteration attempts;
   *  this turns them into the final OptimizeResult. */
  protected async finishPointwise<
    C extends {
      iter: number | "baseline";
      files: Record<string, string>;
      scorecard: Scorecard;
      targetSet: OptimizeTargetSet;
    },
  >(
    source: OptimizeTargetSet,
    candidates: C[],
    trainChampion: C,
    attempts: { iter: number; decision: OptimizeDecision; detail?: string; objective?: number }[],
    startedAt: number,
  ): Promise<OptimizeResult> {
    const { champion, validationObjective, scored } = await this.pickValidationChampion(
      source,
      candidates,
      trainChampion,
    );
    const validationByIter = Object.fromEntries(
      scored.map((s) => [String(s.candidate.iter), s.objective]),
    );
    const baseline = candidates.find((c) => c.iter === "baseline");
    if (this.config.writeback && champion.iter !== "baseline") {
      this.workspace.writeBack(source, champion.files);
    }

    const result = this.buildPointwiseResult({
      championIter: champion.iter,
      championFiles: champion.files,
      attempts: attempts.map((a) => ({
        ...a,
        validationObjective: validationByIter[String(a.iter)],
      })),
      baselineObjective: baseline?.scorecard.gatedObjective(),
      baselineValidationObjective: validationByIter.baseline,
    });

    // Gate-aware: match the score optimizers actually use to compare
    // candidates. Reporting raw `objective()` would let a gate-failing
    // baseline (raw 0.5) appear "better" than a gate-passing champion
    // (raw 0.3) and break consumer comparisons.
    result.trainObjective = champion.scorecard.gatedObjective();
    if (baseline) {
      result.baselineObjective = baseline.scorecard.gatedObjective();
    }

    if (validationObjective !== undefined) {
      result.validationObjective = validationObjective;
    }

    result.championBreakdown = breakdown(champion.scorecard);
    result.cost = this.costSoFar();

    this.reporter.runFinished({
      result,
      initialTargets: source.targets,
      finalTargets: champion.targetSet.targets,
      durationMs: Date.now() - startedAt,
    });

    return result;
  }

  /** Run the agent once per input (cached by (workspace, input)), grade each, return a Scorecard.
   *  The candidate's `files` map is the overlay applied inside each per-input workdir. */
  protected async evaluate(
    ws: CachePartition,
    source: OptimizeTargetSet,
    files: Record<string, string>,
    inputs: Test[],
  ): Promise<Scorecard> {
    // The configured GraderSource IS the objective. In snapshot mode each
    // input's run directory stores its test's graders as the candidate runs,
    // so every candidate is judged by the test's own criteria; an override
    // set replaces them all. The grader files are read from the suite per
    // candidate run — editing them mid-search changes the objective, the
    // same way it would change what eval run records.
    const ctx: GradingContext = {
      graders: this.config.graders,
      runAgency: this.agencyRunner,
      config: this.config.config ?? {},
    };
    const perInput = await Promise.all(
      inputs.map(async (input, index) => {
        const id = inputId(input, index);
        const runDir = await this.cache.get(ws.key, id, () =>
          this.runInput(ws, source, files, input, id),
        );
        // A suite of one, graded like every other run directory.
        const card = await gradeRun(runDir, ctx);
        if (card.perInput.length !== 1) {
          // Guards the suite-of-one contract at the place that depends on it:
          // `runInput` is an injectable seam, and a directory with 0 or 2
          // inputs would otherwise surface much later inside objective().
          throw new Error(
            `runInput for input ${id} returned ${runDir} with ${card.perInput.length} graded inputs; expected exactly 1`,
          );
        }
        return card.perInput[0];
      }),
    );
    return new Scorecard(perInput);
  }

  /** Default runInput: run the agent for one input via the eval-run subprocess path.
   *  Passes `seed` (used verbatim — no closure recomputation, no silent divergence
   *  from `source.baseDir`) and `overlayFiles` (the candidate's complete file map)
   *  to `runSuite`. */
  private async runInputViaEval(
    ws: CachePartition,
    source: OptimizeTargetSet,
    files: Record<string, string>,
    input: Test,
    id: string,
  ): Promise<string> {
    this.runCounter += 1;
    const result = await runSuite({
      // Used for the label and the node name only; the files come from the overlay.
      agent: `${path.join(source.baseDir, source.entryFile)}:${source.entryNode ?? "main"}`,
      inputs: [{ ...input, id }],
      suite: { source: "optimize" },
      out: path.join(
        this.config.runsDir,
        this.config.runId,
        "agent-runs",
        ws.key,
        `run-${this.runCounter}`,
      ),
      config: this.config.config,
      // The reporter owns the optimizer's narrative; runSuite's own progress
      // lines would interleave with it (and `--silent` must print nothing).
      progress: false,
      perRun: {
        pipeOutput: false,
        seed: {
          baseDir: source.baseDir,
          agentRelPath: source.entryFile,
          closureFiles: Object.values(source.files).map((sourceFile) => sourceFile.absoluteFile),
        },
        overlayFiles: files,
      },
    });
    const testResult = result.tests[0];
    if (!testResult || testResult.status !== "success") {
      throw new Error(
        `agent run failed for input ${input.id ?? "(no id)"}: ${testResult?.errorMessage ?? "unknown error"}`,
      );
    }
    this.agentCostUsd += makeStatelogCostTailer(runDirPaths(testResult.runDir).statelog).poll();
    // The one test's run directory, `<out>/<id>/`; `gradeRun` sees exactly one input.
    return testResult.runDir;
  }

  protected async eachIteration(step: (iter: number) => Promise<void>): Promise<void> {
    for (let iter = 1; iter <= this.config.iterations; iter += 1) await step(iter);
  }

  /** Refuse to optimize a program whose baseline already fails a must-pass grader. */
  protected requireBaselineGatesPass(scorecard: Scorecard): void {
    if (scorecard.gatesPassed()) return;
    const failed = failingGraders(scorecard);
    throw new Error(
      `Baseline fails must-pass grader(s) [${failed.join(", ")}] — fix the program or those graders before optimizing.`,
    );
  }

  /** Build the pointwise OptimizeResult shared by greedy and GEPA. */
  protected buildPointwiseResult(args: {
    championIter: number | "baseline";
    championFiles: Record<string, string>;
    attempts: IterationResult[];
    baselineObjective?: number;
    baselineValidationObjective?: number;
  }): OptimizeResult {
    const count = (decision: OptimizeDecision): number =>
      args.attempts.filter((a) => a.decision === decision).length;
    const baselineIteration: IterationResult = { iter: 0, decision: "baseline" };
    if (args.baselineObjective !== undefined) baselineIteration.objective = args.baselineObjective;
    if (args.baselineValidationObjective !== undefined) {
      baselineIteration.validationObjective = args.baselineValidationObjective;
    }
    return {
      runId: this.config.runId,
      runDir: path.join(this.config.runsDir, this.config.runId),
      championIter: args.championIter,
      championFiles: args.championFiles,
      acceptedCount: count("accepted"),
      rejectedCount: count("rejected"),
      validationFailedCount: count("validation-failed"),
      iterations: [
        baselineIteration,
        ...args.attempts.map((a) => ({
          iter: a.iter,
          decision: a.decision,
          ...(a.detail ? { detail: a.detail } : {}),
        })),
      ],
    };
  }
}

/** Names of the must-pass graders that failed on at least one input. */
function failingGraders(scorecard: Scorecard): string[] {
  const names = scorecard.perInput.flatMap((input) =>
    input.grades
      .filter((g) => g.grader.mustPass() && !g.grader.passes(g.grade))
      .map((g) => g.grader.name()),
  );
  return names.filter((name, i) => names.indexOf(name) === i);
}

/** A stable id for an input: its own id when present, otherwise its position. */
function inputId(input: Test, index: number): string {
  return input.id && input.id.trim() !== "" ? input.id : `input-${index}`;
}
