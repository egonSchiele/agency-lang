import * as fs from "fs";
import * as path from "path";

import { evalRunLoadedInputs, optimizeEvalRecordExtractor, resolveEvalRunTarget } from "@/cli/eval/run.js";

import { EvalCache } from "./evalCache.js";
import { breakdown } from "./gradeBreakdown.js";
import { AgencyRunner } from "./grading/agencyRunner.js";
import type { BaseGrader } from "./grading/baseGrader.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./grading/scorecard.js";
import type { AgentRun, Input } from "./grading/types.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import { createPointwiseReporter, type PointwiseReporter } from "./reporter.js";
import type { OptimizeMutationDiagnostic, OptimizeMutationOperation, OptimizeMutationPreview } from "./sourceMutator.js";
import { discoverOptimizeTargets, type OptimizeTargetSet } from "./targets.js";
import type { IterationResult, MutationProposal, OptimizeDecision, OptimizeResult } from "./types.js";
import { WorkspaceManager, type Workspace } from "./workspace.js";

/** Result of proposing a mutation: a clean preview, or the reason it couldn't be produced. */
export type MutationOutcome =
  | { ok: true; preview: OptimizeMutationPreview; rationale: string }
  | { ok: false; rationale: string; diagnostics: OptimizeMutationDiagnostic[] };

const MAX_PROPOSE_ATTEMPTS = 3;

/** A function that runs the agent for one input in a workspace and returns its run.
 *  Receives the candidate's `source` (`baseDir`/`entryFile` live here) and `files`
 *  (the candidate's complete file map, used as the workdir overlay). */
export type RunInput = (
  ws: Workspace,
  source: OptimizeTargetSet,
  files: Record<string, string>,
  input: Input,
  id: string,
) => Promise<AgentRun>;

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
  protected readonly cache: EvalCache;
  protected readonly reporter: PointwiseReporter;
  private readonly runInput: RunInput;
  private readonly discover: (agentFile: string) => OptimizeTargetSet;
  private runCounter = 0;
  /** Held-out validation inputs (empty when none); set in optimize(). */
  protected validationInputs: Input[] = [];

  constructor(protected readonly config: BaseOptimizerConfig, deps: BaseOptimizerDeps = {}) {
    this.workspace = new WorkspaceManager();
    this.agencyRunner = deps.agencyRunner ?? new AgencyRunner(config.config);
    this.cache = deps.cache ?? new EvalCache();
    this.reporter = deps.reporter ?? createPointwiseReporter(config.verbosity ?? "silent");
    this.runInput = deps.runInput ?? ((ws, source, files, input, id) => this.runInputViaEval(ws, source, files, input, id));
    this.discover = deps.discover ?? discoverOptimizeTargets;
  }

  abstract readonly name: string;

  /**
   * Resolve the agent file and discover its optimize targets once, then hand the
   * target set to the subclass. Every optimizer needs this preamble, so it lives
   * here — subclasses implement {@link optimizeTargets} and never touch discovery.
   */
  async optimize(target: OptimizeTarget): Promise<OptimizeResult> {
    const agentFile = resolveEvalRunTarget(target.agent).agentFile;
    const source = this.discover(agentFile);
    if (source.targets.length === 0) {
      throw new Error(`No optimize targets found in ${agentFile}. Mark a declaration with the optimize modifier.`);
    }
    this.validationInputs = target.validationInputs ?? [];
    this.echoAndValidateGrading(target.inputs);
    return this.optimizeTargets(source, target.inputs);
  }

  /** Print the resolved grading setup and fail fast on a misconfigured grader,
   *  checked against the first input before any agent run. */
  private echoAndValidateGrading(inputs: Input[]): void {
    this.reporter.gradingSetup({
      graders: this.config.graders.map((g) => ({ name: g.name(), describe: g.describe() })),
      firstInput: inputs[0] ? { id: inputs[0].id ?? "(no id)", goal: inputs[0].goal } : undefined,
    });
    const first = inputs[0];
    if (!first) return;
    for (const grader of this.config.graders) {
      if (grader.gradesInput(first)) grader.validateInput(first);
    }
  }

  /** Run the search over already-discovered targets. The one method an optimizer must implement. */
  protected abstract optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult>;

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
      try {
        proposal = await propose(diagnostics);
      } catch (error) {
        rationale = `proposer returned a malformed response: ${error instanceof Error ? error.message : String(error)}`;
        diagnostics = [];
        continue;
      }
      rationale = proposal.rationale;
      const result = preview(proposal.operations);
      if (result.diagnostics.length === 0) return { ok: true, preview: result, rationale };
      diagnostics = result.diagnostics;
    }
    return { ok: false, rationale, diagnostics };
  }

  protected fork(): Workspace {
    return this.workspace.fork();
  }

  /** Allocate a fresh cache-partition workspace and grade `files` on `inputs`.
   *  The canonical fresh-scoring primitive (used for validation). */
  protected async scoreFiles(source: OptimizeTargetSet, files: Record<string, string>, inputs: Input[]): Promise<Scorecard> {
    const ws = this.fork();
    return this.evaluate(ws, source, files, inputs);
  }

  /** Choose the writeback champion among candidates: the one with the best
   *  validation objective when a validation set exists, else the given train
   *  champion. Scoring (the "how") is separated from the max selection (the
   *  "what"); shared by the pointwise optimizers so validation selection lives
   *  in one place. */
  protected async pickValidationChampion<C extends { files: Record<string, string>; scorecard: Scorecard }>(
    source: OptimizeTargetSet,
    candidates: C[],
    trainChampion: C,
  ): Promise<{ champion: C; validationObjective?: number }> {
    if (this.validationInputs.length === 0) return { champion: trainChampion };
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
    return { champion: winner.candidate, validationObjective: winner.objective };
  }

  /** The shared tail every pointwise optimizer runs: pick the writeback champion
   *  (by validation when configured), write it back, build the result with its
   *  train/validation objectives + grade breakdown, and report completion. An
   *  optimizer's job is just to produce the candidates and per-iteration attempts;
   *  this turns them into the final OptimizeResult. */
  protected async finishPointwise<C extends { iter: number | "baseline"; files: Record<string, string>; scorecard: Scorecard; targetSet: OptimizeTargetSet }>(
    source: OptimizeTargetSet,
    candidates: C[],
    trainChampion: C,
    attempts: { iter: number; decision: OptimizeDecision; detail?: string }[],
    startedAt: number,
  ): Promise<OptimizeResult> {
    const { champion, validationObjective } = await this.pickValidationChampion(source, candidates, trainChampion);
    if (this.config.writeback && champion.iter !== "baseline") {
      this.workspace.writeBack(source, champion.files);
    }

    const result = this.buildPointwiseResult({
      championIter: champion.iter,
      championFiles: champion.files,
      attempts
    });

    // Gate-aware: match the score optimizers actually use to compare
    // candidates. Reporting raw `objective()` would let a gate-failing
    // baseline (raw 0.5) appear "better" than a gate-passing champion
    // (raw 0.3) and break consumer comparisons.
    result.trainObjective = champion.scorecard.gatedObjective();
    const baseline = candidates.find((c) => c.iter === "baseline");
    if (baseline) {
      result.baselineObjective = baseline.scorecard.gatedObjective();
    }

    if (validationObjective !== undefined) {
      result.validationObjective = validationObjective;
    }

    result.championBreakdown = breakdown(champion.scorecard);

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
    ws: Workspace,
    source: OptimizeTargetSet,
    files: Record<string, string>,
    inputs: Input[],
  ): Promise<Scorecard> {
    const perInput = await Promise.all(
      inputs.map((input, index) => this.gradeInput(ws, source, files, input, inputId(input, index))),
    );
    return new Scorecard(perInput);
  }

  private async gradeInput(
    ws: Workspace,
    source: OptimizeTargetSet,
    files: Record<string, string>,
    input: Input,
    id: string,
  ): Promise<InputGrades> {
    const run = await this.cache.get(ws.key, id, () => this.runInput(ws, source, files, input, id));
    const gates = this.config.graders.filter((g) => g.mustPass() && g.gradesInput(input));
    const advisory = this.config.graders.filter((g) => !g.mustPass() && g.gradesInput(input));

    const gateGrades: GraderGrade[] = [];
    for (const grader of gates) {
      const grade = await grader.run({ input, run, runAgency: this.agencyRunner });

      gateGrades.push({ grader, grade });
      if (!grader.passes(grade)) {
        return { input, run, grades: gateGrades, gatesPassed: false };
      }
    }
    const advisoryGrades = await Promise.all(
      advisory.map(async (grader) => ({ grader, grade: await grader.run({ input, run, runAgency: this.agencyRunner }) })),
    );

    return {
      input,
      run,
      grades: [...gateGrades, ...advisoryGrades],
      gatesPassed: true
    };
  }

  /** Default runInput: run the agent for one input via the eval-run subprocess path.
   *  Passes `seed` (used verbatim — no closure recomputation, no silent divergence
   *  from `source.baseDir`) and `overlayFiles` (the candidate's complete file map)
   *  to `evalRunLoadedInputs`. The per-input `working_dir` field is forbidden
   *  here (the caller-supplied seed would conflict with it). */
  private async runInputViaEval(
    ws: Workspace,
    source: OptimizeTargetSet,
    files: Record<string, string>,
    input: Input,
    id: string,
  ): Promise<AgentRun> {
    this.runCounter += 1;
    const result = await evalRunLoadedInputs({
      agent: path.join(source.baseDir, source.entryFile),  // used for label/node parsing only
      inputs: [{ ...input, id, working_dir: undefined }],  // working_dir conflicts with seed
      inputsSource: "optimize",
      runsDir: path.join(this.config.runsDir, this.config.runId, "agent-runs", ws.key),
      runId: `run-${this.runCounter}`,
      config: this.config.config,
      continueOnError: true,
      quietCompile: true,
      pipeAgentOutput: false,
      seed: { dir: source.baseDir, agentRelPath: source.entryFile },
      overlayFiles: files,
    }, {
      // Grade the node's return value (not its last LLM reply) and skip the
      // evalValue/evalOutput "did you forget to call…" warnings — neither
      // applies to optimize: inputs come from the input spec, output is the return.
      extractor: optimizeEvalRecordExtractor,
    });
    const inputResult = result.inputs[0];
    if (!inputResult || inputResult.status !== "success") {
      throw new Error(`agent run failed for input ${input.id ?? "(no id)"}: ${inputResult?.errorMessage ?? "unknown error"}`);
    }
    const record = JSON.parse(fs.readFileSync(inputResult.evalRecordPath, "utf8")) as { evalOutputs?: { value: unknown }[] };
    const output = gradedOutput(record.evalOutputs ?? [], input.id ?? id);
    return { output: output as AgentRun["output"], recordPath: inputResult.evalRecordPath };
  }

  protected async eachIteration(step: (iter: number) => Promise<void>): Promise<void> {
    for (let iter = 1; iter <= this.config.iterations; iter += 1) await step(iter);
  }

  protected get graders(): BaseGrader[] {
    return this.config.graders;
  }

  /** Refuse to optimize a program whose baseline already fails a must-pass grader. */
  protected requireBaselineGatesPass(scorecard: Scorecard): void {
    if (scorecard.gatesPassed()) return;
    const failed = failingGraders(scorecard);
    throw new Error(
      `Baseline fails must-pass grader(s) [${failed.join(", ")}] — fix the program or those graders before optimizing.`,
    );
  }

  /**
   * Build the pointwise OptimizeResult shared by greedy and GEPA. `winsA`/`winsB`/`ties`
   * are pairwise-judge artifacts that pointwise optimizers leave at 0.
   */
  protected buildPointwiseResult(args: {
    championIter: number | "baseline";
    championFiles: Record<string, string>;
    attempts: { iter: number; decision: OptimizeDecision; detail?: string }[];
  }): OptimizeResult {
    const count = (decision: OptimizeDecision): number => args.attempts.filter((a) => a.decision === decision).length;
    const baselineIteration: IterationResult = { iter: 0, decision: "baseline", winsA: 0, winsB: 0, ties: 0 };
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
          iter: a.iter, decision: a.decision, winsA: 0, winsB: 0, ties: 0,
          ...(a.detail ? { detail: a.detail } : {}),
        })),
      ],
    };
  }
}

/** Names of the must-pass graders that failed on at least one input. */
function failingGraders(scorecard: Scorecard): string[] {
  const names = scorecard.perInput.flatMap((input) =>
    input.grades.filter((g) => g.grader.mustPass() && !g.grader.passes(g.grade)).map((g) => g.grader.name()),
  );
  return names.filter((name, i) => names.indexOf(name) === i);
}

/** A stable id for an input: its own id when present, otherwise its position. */
function inputId(input: Input, index: number): string {
  return input.id && input.id.trim() !== "" ? input.id : `input-${index}`;
}

/**
 * The last graded output value, or a clear error when there is none — the agent
 * returned nothing AND didn't call evalOutput(), so there is nothing to grade.
 */
export function gradedOutput(evalOutputs: { value: unknown }[], inputLabel: string): unknown {
  if (evalOutputs.length === 0) {
    throw new Error(
      `Agent produced no output to grade for input "${inputLabel}": the entry node returned nothing and ` +
      `evalOutput() was not called. Return a value from the node, or call evalOutput(value) to record what the optimizer should grade.`,
    );
  }
  return evalOutputs[evalOutputs.length - 1].value;
}
