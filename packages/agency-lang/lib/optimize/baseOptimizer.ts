import * as fs from "fs";
import * as path from "path";

import { evalRunLoadedTasks, optimizeEvalRecordExtractor, resolveEvalRunTarget } from "@/cli/eval/run.js";
import type { EvalTask } from "@/eval/runTypes.js";

import { EvalCache } from "./evalCache.js";
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

/** A function that runs the agent for one input in a workspace and returns its run. */
export type RunInput = (ws: Workspace, entryFile: string, input: Input, id: string) => Promise<AgentRun>;

export type BaseOptimizerDeps = {
  workspaceRoot?: string;
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

  constructor(protected readonly config: BaseOptimizerConfig, deps: BaseOptimizerDeps = {}) {
    this.workspace = new WorkspaceManager(deps.workspaceRoot ?? path.join(config.runsDir, config.runId, "ws"));
    this.agencyRunner = deps.agencyRunner ?? new AgencyRunner(config.config);
    this.cache = deps.cache ?? new EvalCache();
    this.reporter = deps.reporter ?? createPointwiseReporter(config.verbosity ?? "silent");
    this.runInput = deps.runInput ?? ((ws, entryFile, input, id) => this.runInputViaEval(ws, entryFile, input, id));
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
    return this.optimizeTargets(source, target.inputs);
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

  protected fork(sourceDir: string): Workspace {
    return this.workspace.fork(sourceDir);
  }

  /** Run the agent once per input (cached by (workspace,input)), grade each, return a Scorecard. */
  protected async evaluate(ws: Workspace, entryFile: string, inputs: Input[]): Promise<Scorecard> {
    const perInput = await Promise.all(
      inputs.map((input, index) => this.gradeInput(ws, entryFile, input, inputId(input, index))),
    );
    return new Scorecard(perInput);
  }

  private async gradeInput(ws: Workspace, entryFile: string, input: Input, id: string): Promise<InputGrades> {
    const run = await this.cache.get(ws.key, id, () => this.runInput(ws, entryFile, input, id));
    const gates = this.config.graders.filter((g) => g.mustPass() && g.gradesInput(input));
    const advisory = this.config.graders.filter((g) => !g.mustPass() && g.gradesInput(input));

    const gateGrades: GraderGrade[] = [];
    for (const grader of gates) {                                  // sequential: short-circuit
      const grade = await grader.run({ input, run, runAgency: this.agencyRunner });
      gateGrades.push({ grader, grade });
      if (!grader.passes(grade)) return { input, run, grades: gateGrades, gatesPassed: false };
    }
    const advisoryGrades = await Promise.all(
      advisory.map(async (grader) => ({ grader, grade: await grader.run({ input, run, runAgency: this.agencyRunner }) })),
    );
    return { input, run, grades: [...gateGrades, ...advisoryGrades], gatesPassed: true };
  }

  /** Default runInput: run the agent for one input via the eval-run subprocess path (named args). */
  private async runInputViaEval(ws: Workspace, entryFile: string, input: Input, id: string): Promise<AgentRun> {
    const task: EvalTask = {
      task_id: id,
      goal: "",
      args: input.args,
      ...(input.node ? { node: input.node } : {}),
    };
    this.runCounter += 1;
    const result = await evalRunLoadedTasks({
      agent: path.join(ws.dir, entryFile),
      tasks: [task],
      tasksSource: "optimize",
      runsDir: path.join(this.config.runsDir, this.config.runId, "agent-runs", ws.key),
      runId: `run-${this.runCounter}`,
      config: this.config.config,
      continueOnError: true,
      quietCompile: true,
      pipeAgentOutput: false,
    }, {
      // Grade the node's return value (not its last LLM reply) and skip the
      // evalInput/evalOutput "did you forget to call…" warnings — neither
      // applies to optimize: inputs come from the task, output is the return.
      extractor: optimizeEvalRecordExtractor,
    });
    const taskResult = result.tasks[0];
    if (!taskResult || taskResult.status !== "success") {
      throw new Error(`agent run failed for input ${input.id ?? "(no id)"}: ${taskResult?.errorMessage ?? "unknown error"}`);
    }
    const record = JSON.parse(fs.readFileSync(taskResult.evalRecordPath, "utf8")) as { evalOutputs?: { value: unknown }[] };
    const output = gradedOutput(record.evalOutputs ?? [], input.id ?? id);
    return { output: output as AgentRun["output"], recordPath: taskResult.evalRecordPath };
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
