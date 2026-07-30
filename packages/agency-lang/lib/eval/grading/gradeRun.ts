import * as fs from "fs";
import * as path from "path";

import { readEvalRun, type ReadEvalRunInput } from "@/eval/readRun.js";
import type { Input } from "@/eval/runTypes.js";
import type { EvalRecord } from "@/eval/types.js";

import type { AgencyRunner } from "./agencyRunner.js";
import type { BaseGrader } from "./baseGrader.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./scorecard.js";
import type { LoadedRun, JSON as Json } from "./types.js";

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
 * An input with nothing to grade is scored 0 rather than throwing — see
 * {@link lookUpOutput} for the three ways that happens, each with its own reason.
 * A suite needs mixed results, not an abort. The optimizer still refuses a
 * baseline in this state, via `requireBaselineGatesPass`.
 */
async function gradeInput(entry: Entry, ctx: GradingContext): Promise<InputGrades> {
  const input = entry.input;
  const lookup = lookUpOutput(entry.recordPath, entry.workdir);
  if ("reason" in lookup) {
    return ungraded(input, lookup.reason);
  }
  const run = lookup.run;

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
 * Fail fast on a misconfigured grader, checked against one input before any agent
 * runs. Match-based graders override `validateInput` to reject an unresolved
 * `matchOn`; without this the error surfaces per input, after the whole suite has
 * already been run and paid for. Mirrors what `BaseOptimizer` does in its preamble.
 */
export function validateGraders(graders: BaseGrader[], input: Input | undefined): void {
  if (input === undefined) {
    return;
  }
  for (const grader of graders) {
    if (grader.gradesInput(input)) {
      grader.validateInput(input);
    }
  }
}

/**
 * Score every input in a run directory. The run directory is grading's ONLY
 * input: run data is never handed over in memory, so `eval run --grade`
 * deliberately re-reads the artifacts it just wrote — the same call `eval
 * grade` makes days later. (See docs/dev/eval-grading.md.)
 *
 * Duplicate input ids collapse in the loader's by-id map, changing the mean's
 * denominator — callers must keep ids unique. The CLI validates this;
 * programmatic callers own it (`readEvalRun` warns on collision).
 */
export async function gradeRun(runDir: string, ctx: GradingContext): Promise<Scorecard> {
  const loaded = readEvalRun(runDir);
  const perInput = await Promise.all(
    Object.values(loaded.inputsById).map((input) => gradeEntry(loadedEntry(loaded.runDir, input), ctx)),
  );
  return new Scorecard(perInput);
}

/** What grading needs from one loaded input: the spec, where its evidence
 *  lives, and optionally a reason not to grade at all. */
type Entry = {
  input: Input;
  recordPath: string;
  workdir: string;
  /** Set when the input cannot be graded at all — skip straight to a scored zero. */
  ungradedReason?: string;
};

/** Grade one entry, or score it 0 when there is nothing gradable. */
async function gradeEntry(entry: Entry, ctx: GradingContext): Promise<InputGrades> {
  if (entry.ungradedReason !== undefined) {
    return ungraded(entry.input, entry.ungradedReason);
  }
  return gradeInput(entry, ctx);
}

/**
 * One entry from a run read off disk. `readEvalRun` reports three statuses and
 * they mean different things to a user: a run that failed, versus one that
 * succeeded but whose record is gone. Blaming the agent for the second would
 * point them at the wrong problem, so each status names its own reason.
 *
 * THE POLICY LIVES HERE: an errored run scores zero, always. Its salvaged
 * eval-record.json on disk is diagnostic evidence and is never graded —
 * `reasonByStatus.failed` diverts it from graders regardless of whether a
 * record exists.
 */
function loadedEntry(runDir: string, input: ReadEvalRunInput): Entry {
  const reasonByStatus: Record<ReadEvalRunInput["status"], string | undefined> = {
    ok: undefined,
    failed: agentErrored(input.errorMessage),
    missing: "no eval record found on disk for this input",
  };
  return {
    input: input.input ?? { id: input.inputId, args: {} },
    recordPath: input.recordPath ?? "",
    workdir: workdirFor(runDir, input.inputId),
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

/** Either the run to grade, or why there is nothing to grade. */
type OutputLookup = { run: LoadedRun } | { reason: string };

/**
 * Read the record and pull out the graded output.
 *
 * Three distinct failures, each with its own reason: no record on disk, a record
 * that will not parse, and a record carrying no output. Conflating them sends the
 * reader after the wrong problem. A corrupt record in particular must not throw:
 * in the `eval run` inline path the exception would arrive after every agent had
 * already run and been paid for, taking the whole result down over one bad file.
 */
function lookUpOutput(recordPath: string, workdir: string): OutputLookup {
  if (!recordPath || !fs.existsSync(recordPath)) {
    return { reason: "no eval record found on disk for this input" };
  }
  let record: EvalRecord;
  try {
    record = globalThis.JSON.parse(fs.readFileSync(recordPath, "utf8")) as EvalRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`grading: could not read eval record ${recordPath}: ${message}`);
    return { reason: `eval record unreadable: ${message}` };
  }
  const outputs = record.evalOutputs ?? [];
  if (outputs.length === 0) {
    return { reason: "the agent produced no output to grade" };
  }
  return {
    run: {
      output: outputs[outputs.length - 1].value as Json,
      recordPath,
      workdir,
      record,
    },
  };
}
