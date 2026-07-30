import * as fs from "fs";
import * as path from "path";

import { readEvalRun, type ReadEvalRunInput, type ReadEvalRunResult } from "@/eval/readRun.js";
import type { EvalRunInputResult, EvalRunResult, Input } from "@/eval/runTypes.js";
import type { EvalRecord } from "@/eval/types.js";

import type { AgencyRunner } from "./agencyRunner.js";
import type { BaseGrader } from "./baseGrader.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./scorecard.js";
import type { AgentRun, JSON as Json } from "./types.js";

/** What grading needs besides the run itself. */
export type GradingContext = {
  graders: BaseGrader[];
  /** Capability to execute a judge .agency file. Built from an AgencyConfig. */
  runAgency: AgencyRunner;
};

/**
 * Score one input. Gates run first and short-circuit the input the moment one
 * fails, so a failing gate never pays for the advisory graders behind it.
 *
 * An input that produced nothing is scored 0 rather than throwing: a suite needs
 * mixed results, not an abort. The optimizer still refuses a baseline in this
 * state, via `requireBaselineGatesPass`.
 */
export async function gradeInput(
  input: Input,
  result: EvalRunInputResult,
  ctx: GradingContext,
): Promise<InputGrades> {
  const run = buildAgentRun(result);
  if (run === null) {
    return ungraded(input, "the agent produced no output to grade");
  }

  const applicable = ctx.graders.filter((grader) => grader.gradesInput(input));
  const gates = applicable.filter((grader) => grader.mustPass());
  const advisory = applicable.filter((grader) => !grader.mustPass());

  const gateGrades: GraderGrade[] = [];
  for (const grader of gates) {
    const grade = await grader.run({ input, run, runAgency: ctx.runAgency });
    gateGrades.push({ grader, grade });
    if (!grader.passes(grade)) {
      return { input, run, grades: gateGrades, gatesPassed: false };
    }
  }

  const advisoryGrades = await Promise.all(
    advisory.map(async (grader) => ({
      grader,
      grade: await grader.run({ input, run, runAgency: ctx.runAgency }),
    })),
  );

  return { input, run, grades: [...gateGrades, ...advisoryGrades], gatesPassed: true };
}

/**
 * Score every input in a run. Accepts an in-memory result, an already-loaded
 * run, or a run directory path — the same union `judgeSuite` takes.
 *
 * An input whose agent run errored is scored 0 and marked gate-failed here
 * rather than inside `gradeInput`: it is eval-side policy, and such an input may
 * have no eval record on disk at all. The optimizer never reaches this path,
 * because its run step throws on a failed run first.
 */
export async function gradeRun(
  run: EvalRunResult | ReadEvalRunResult | string,
  ctx: GradingContext,
): Promise<Scorecard> {
  const perInput = await Promise.all(
    toEntries(run).map((entry) => gradeEntry(entry, ctx)),
  );
  return new Scorecard(perInput);
}

type Entry = {
  input: Input;
  result: EvalRunInputResult;
  /** Set when the input cannot be graded at all — skip straight to a scored zero. */
  ungradedReason?: string;
};

/** Grade one entry, or score it 0 when there is nothing gradable. */
async function gradeEntry(entry: Entry, ctx: GradingContext): Promise<InputGrades> {
  if (entry.ungradedReason !== undefined) {
    return ungraded(entry.input, entry.ungradedReason);
  }
  return gradeInput(entry.input, entry.result, ctx);
}

function toEntries(run: EvalRunResult | ReadEvalRunResult | string): Entry[] {
  const loaded = typeof run === "string" ? readEvalRun(run) : run;
  if ("inputsById" in loaded) {
    return Object.values(loaded.inputsById).map((input) => loadedEntry(loaded.runDir, input));
  }
  return loaded.inputs.map((result) => ({
    input: readInputSpec(result) ?? { id: result.inputId, args: {} },
    result,
    ungradedReason: result.status === "error" ? agentErrored(result.errorMessage) : undefined,
  }));
}

/**
 * One entry from a run read off disk. `readEvalRun` reports three statuses and
 * they mean different things to a user: a run that failed, versus one that
 * succeeded but whose record is gone. Blaming the agent for the second would
 * point them at the wrong problem, so each status names its own reason.
 */
function loadedEntry(runDir: string, input: ReadEvalRunInput): Entry {
  const reasonByStatus: Record<ReadEvalRunInput["status"], string | undefined> = {
    ok: undefined,
    failed: agentErrored(input.errorMessage),
    missing: "no eval record found on disk for this input",
  };
  return {
    input: input.input ?? { id: input.inputId, args: {} },
    result: {
      inputId: input.inputId,
      status: input.status === "ok" ? "success" : "error",
      evalRecordPath: input.recordPath ?? "",
      statelogPath: "",
      workdirPath: workdirFor(runDir, input.inputId),
      errorMessage: input.errorMessage,
    },
    ungradedReason: reasonByStatus[input.status],
  };
}

function agentErrored(message: string | undefined): string {
  return `the agent run errored: ${message ?? "unknown error"}`;
}

function workdirFor(runDir: string, inputId: string): string {
  return path.join(runDir, "inputs", inputId, "workdir");
}

/** An input that scored 0 without being graded. */
function ungraded(input: Input, reason: string): InputGrades {
  return { input, run: null, grades: [], gatesPassed: false, ungradedReason: reason };
}

/**
 * The input spec `prepareInput` wrote next to the workdir. An in-memory
 * EvalRunResult carries only per-input *results*, not the specs, and graders
 * need the spec — `LlmJudge` reads `goal` and `ExactMatch` reads `expected`.
 * Both would silently score against nothing if we synthesized a bare input.
 */
function readInputSpec(result: EvalRunInputResult): Input | null {
  if (!result.workdirPath) {
    return null;
  }
  const file = path.join(path.dirname(result.workdirPath), "input.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  return globalThis.JSON.parse(fs.readFileSync(file, "utf8")) as Input;
}

/** Read the record and pull out the graded output. Null when there is none. */
function buildAgentRun(result: EvalRunInputResult): AgentRun | null {
  if (!result.evalRecordPath || !fs.existsSync(result.evalRecordPath)) {
    return null;
  }
  const record = globalThis.JSON.parse(fs.readFileSync(result.evalRecordPath, "utf8")) as EvalRecord;
  const outputs = record.evalOutputs ?? [];
  if (outputs.length === 0) {
    return null;
  }
  return {
    output: outputs[outputs.length - 1].value as Json,
    recordPath: result.evalRecordPath,
    workdir: result.workdirPath,
    record,
  };
}
