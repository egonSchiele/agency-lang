import * as fs from "fs";
import * as path from "path";

import { evalRunLoadedTasks } from "@/cli/eval/run.js";
import type { EvalTask } from "@/eval/runTypes.js";

import { EvalCache } from "./evalCache.js";
import { AgencyRunner } from "./grading/agencyRunner.js";
import type { BaseGrader } from "./grading/baseGrader.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./grading/scorecard.js";
import type { AgentRun, Input } from "./grading/types.js";
import type { BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
import type { OptimizeResult } from "./types.js";
import { WorkspaceManager, type Workspace } from "./workspace.js";

/** A function that runs the agent for one input in a workspace and returns its run. */
export type RunInput = (ws: Workspace, entryFile: string, input: Input, id: string) => Promise<AgentRun>;

export type BaseOptimizerDeps = {
  workspaceRoot?: string;
  agencyRunner?: AgencyRunner;
  cache?: EvalCache;
  /** Override how the agent under test runs (tests inject a fake; default uses the eval-run path). */
  runInput?: RunInput;
};

export abstract class BaseOptimizer {
  protected readonly workspace: WorkspaceManager;
  protected readonly agencyRunner: AgencyRunner;
  protected readonly cache: EvalCache;
  private readonly runInput: RunInput;
  private runCounter = 0;

  constructor(protected readonly config: BaseOptimizerConfig, deps: BaseOptimizerDeps = {}) {
    this.workspace = new WorkspaceManager(deps.workspaceRoot ?? path.join(config.runsDir, config.runId, "ws"));
    this.agencyRunner = deps.agencyRunner ?? new AgencyRunner(config.config);
    this.cache = deps.cache ?? new EvalCache();
    this.runInput = deps.runInput ?? ((ws, entryFile, input, id) => this.runInputViaEval(ws, entryFile, input, id));
  }

  abstract readonly name: string;
  abstract optimize(target: OptimizeTarget): Promise<OptimizeResult>;

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
    });
    const taskResult = result.tasks[0];
    if (!taskResult || taskResult.status !== "success") {
      throw new Error(`agent run failed for input ${input.id ?? "(no id)"}: ${taskResult?.errorMessage ?? "unknown error"}`);
    }
    const record = JSON.parse(fs.readFileSync(taskResult.evalRecordPath, "utf8")) as { evalOutputs?: { value: unknown }[] };
    const outputs = record.evalOutputs ?? [];
    const output = outputs.length > 0 ? outputs[outputs.length - 1].value : null;
    return { output: output as AgentRun["output"], recordPath: taskResult.evalRecordPath };
  }

  protected async eachIteration(step: (iter: number) => Promise<void>): Promise<void> {
    for (let iter = 1; iter <= this.config.iterations; iter += 1) await step(iter);
  }

  protected get graders(): BaseGrader[] {
    return this.config.graders;
  }
}

/** A stable id for an input: its own id when present, otherwise its position. */
function inputId(input: Input, index: number): string {
  return input.id && input.id.trim() !== "" ? input.id : `input-${index}`;
}
