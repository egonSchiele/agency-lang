import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import type { Test } from "@/eval/runTypes.js";
import type { EvalRecord } from "@/eval/types.js";
import type {
  Annotation,
  EffectiveTraceAnnotations,
  GradersIdentity,
  HarnessRecord,
} from "@/runDirectory/annotations.js";
import { evalRecordFor, traceEnding } from "@/runDirectory/evalRecord.js";
import { humanFeedbackFor, type HumanFeedback } from "@/runDirectory/humanFeedback.js";
import { readRunDirectory, runDirPaths, type RunDirectorySnapshot } from "@/runDirectory/runDir.js";
import type { Trace } from "@/runDirectory/traces.js";

import type { AgencyRunner } from "./agencyRunner.js";
import type { BaseGrader } from "./baseGrader.js";
import { AgencyTestGrader } from "./agencyTestGrader.js";
import { loadGradingModule, loadGradingSnapshot } from "./gradingModule.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./scorecard.js";
import type { LoadedRun, JSON as Json } from "./types.js";

/** The suite-level grader set and what it means against a test's own graders
 *  (a test's recorded `graders` module). "override" (an explicit --graders
 *  flag) replaces every test's own graders — the experiment knob. "fallback"
 *  (eval.graders config, or the bundled goal judge) applies only to tests
 *  that carry none. */
export type SuiteGraders = { mode: "override" | "fallback"; graders: BaseGrader[] };

/** What grading needs besides the run directory itself. */
export type GradingContext = {
  suiteGraders: SuiteGraders;
  /** Capability to execute a judge .agency file. Built from an AgencyConfig. */
  runAgency: AgencyRunner;
  /** For loading per-test grading modules. */
  config: AgencyConfig;
  /** `eval grade --goal`: the goal for every test that recorded none of its
   *  own (an ad-hoc trace, or a suite that never had goals). A test's own
   *  goal always wins. */
  defaultGoal?: string;
};

/**
 * Score every trace in a run directory. The run directory is grading's ONLY
 * input: run data is never handed over in memory, so grading right after
 * `eval run` reads the same directory `eval grade` reads days later. (See
 * docs/dev/eval-grading.md.)
 */
export async function gradeRun(runDir: string, ctx: GradingContext): Promise<Scorecard> {
  return gradeSnapshot(readRunDirectory(runDir, { reportWarning: warn }), ctx);
}

/** The same, from a snapshot the caller already read. */
export async function gradeSnapshot(
  snapshot: RunDirectorySnapshot,
  ctx: GradingContext,
): Promise<Scorecard> {
  const moduleCache = makeGraderModuleCache(ctx.config);
  const perInput = await Promise.all(
    gradableEntries(snapshot).map(async (bare) => {
      const entry = withDefaultGoal(bare, ctx.defaultGoal);
      const graders = await effectiveGraders(entry, ctx, moduleCache, snapshot.dir);
      return gradeEntry(entry, ctx, graders);
    }),
  );
  return new Scorecard(perInput);
}

/** Every trace, plus every harness `run` row whose trace never made it into
 *  the statelog (the agent died before its first event). Those runs are
 *  tests too; leaving them out would let a suite where half the tests never
 *  started score as if only the other half existed. */
function gradableEntries(snapshot: RunDirectorySnapshot): Entry[] {
  const entries = snapshot.traces.map((trace) => entryFor(snapshot, trace));
  const withTrace: Record<string, true> = Object.create(null);
  for (const trace of snapshot.traces) withTrace[trace.traceId] = true;
  for (const [traceId, effective] of Object.entries(snapshot.effectiveAnnotations)) {
    if (withTrace[traceId] === true || effective.run === null) continue;
    entries.push(tracelessEntry(snapshot, effective.run, traceId));
  }
  return entries;
}

/** Fill in the grading-time goal where the test has none of its own. */
function withDefaultGoal(entry: Entry, defaultGoal: string | undefined): Entry {
  if (defaultGoal === undefined) return entry;
  const own = entry.test.goal;
  if (typeof own === "string" && own.trim() !== "") return entry;
  return { ...entry, test: { ...entry.test, goal: defaultGoal } };
}

/** A run row with no trace behind it. Whatever the row says about how the run
 *  ended, there is nothing to grade, so it scores zero with the row's reason. */
function tracelessEntry(
  snapshot: RunDirectorySnapshot,
  runRow: Annotation,
  traceId: string,
): Entry {
  const test = testOf(runRow, traceId);
  const ended = runRow.kind === "run" ? runRow.ended : "unknown";
  const detail = runRow.kind === "run" && runRow.error !== undefined ? `: ${runRow.error}` : "";
  return {
    test,
    humanFeedback: humanFeedbackFor(snapshot, traceId),
    ungradedReason: `the run produced no trace and ended with ${ended}${detail}`,
  };
}

/**
 * Fail fast on a misconfigured grader, checked against one test before any agent
 * runs. Match-based graders override `validateInput` to reject an unresolved
 * `matchOn`; without this the error surfaces per test, after the whole suite has
 * already been run and paid for. Mirrors what `BaseOptimizer` does in its preamble.
 */
export function validateGraders(graders: BaseGrader[], test: Test | undefined): void {
  if (test === undefined) {
    return;
  }
  for (const grader of graders) {
    if (grader.gradesInput(test)) {
      grader.validateInput(test);
    }
  }
}

/** Which graders score this test. Precedence: override > the test-owned
 *  snapshot the run directory stored > the test's recorded module path (a
 *  directory from before snapshots) > a config-origin snapshot > fallback.
 *  A config-origin snapshot is skipped under `--goal` (`ctx.defaultGoal`):
 *  the goal promises the goal judge and sets configured modules aside, the
 *  run-time copy included — only a test's OWN graders survive it. */
async function effectiveGraders(
  entry: Entry,
  ctx: GradingContext,
  cache: (modulePath: string) => Promise<BaseGrader[]>,
  runDir: string,
): Promise<BaseGrader[]> {
  // Harness graders are the test's own, always: neither `--graders` nor
  // `--goal` sets them aside.
  const harness = harnessGraders(entry, runDir);
  return [...(await moduleGraders(entry, ctx, cache, runDir)), ...harness];
}

async function moduleGraders(
  entry: Entry,
  ctx: GradingContext,
  cache: (modulePath: string) => Promise<BaseGrader[]>,
  runDir: string,
): Promise<BaseGrader[]> {
  if (ctx.suiteGraders.mode === "override") {
    return ctx.suiteGraders.graders;
  }
  const snapshot = entry.graders;
  if (snapshot !== undefined && snapshot.origin === "test") {
    return loadGradingSnapshot(runDirPaths(runDir).gradersDir, snapshot);
  }
  if (entry.test.graders !== undefined) {
    return cache(entry.test.graders);
  }
  if (snapshot !== undefined && ctx.defaultGoal === undefined) {
    return loadGradingSnapshot(runDirPaths(runDir).gradersDir, snapshot);
  }
  return ctx.suiteGraders.graders;
}

/** One AgencyTestGrader per harness record, bound to the run directory's
 *  stored copy of the pair. */
function harnessGraders(entry: Entry, runDir: string): BaseGrader[] {
  const gradersDir = runDirPaths(runDir).gradersDir;
  return (entry.harness ?? []).map((record) => {
    for (const stored of [record.agency, record.json]) {
      if (!fs.existsSync(path.join(gradersDir, stored))) {
        throw new Error(
          `Harness snapshot not found: ${path.join(gradersDir, stored)} (recorded for ${record.name}).`,
        );
      }
    }
    return new AgencyTestGrader({
      name: record.name,
      harnessAgency: path.join(gradersDir, record.agency),
      harnessJson: path.join(gradersDir, record.json),
      ...(record.maxCost === undefined ? {} : { maxCost: record.maxCost }),
    });
  });
}

/** One esbuild+import per module path per call, however many tests share a
 *  grading module. Exported so the run CLI's pre-run validation loads
 *  through the same path grading does. */
export function makeGraderModuleCache(
  config: AgencyConfig,
): (modulePath: string) => Promise<BaseGrader[]> {
  // Null prototype: modulePath comes from suite content (test.graders), and
  // a key like "__proto__" on a normal object would corrupt the cache.
  const loads: Record<string, Promise<BaseGrader[]>> = Object.create(null);
  return (modulePath) => {
    loads[modulePath] ??= loadGradingModule(modulePath, config);
    return loads[modulePath];
  };
}

/** What grading needs from one trace: the test it ran, its evidence, and
 *  optionally a reason not to grade at all. */
type Entry = {
  test: Test;
  humanFeedback: HumanFeedback;
  graders?: GradersIdentity;
  harness?: HarnessRecord[];
} & (
  | { run: LoadedRun }
  /** The trace cannot be graded at all: skip straight to a scored zero. */
  | { ungradedReason: string }
);

/**
 * One entry from a run directory. THE POLICY LIVES HERE: a run that did not
 * end cleanly scores zero, always. The harness's `run` row is authoritative
 * when present (it alone knows about a timeout or cost-cap kill); without one
 * (an ad-hoc directory), the trace's own ending decides. A run that almost
 * finished must not earn points from a judge that cannot tell it crashed.
 *
 * A trace with NO recorded output is not a failure: command agents (the
 * agency CLI under --agent-cmd) do not emit the output event file agents do,
 * and for terminal-bench-style tests the deliverable is the FILESYSTEM, which
 * graders read from the workdir. Grading proceeds with `output: null` —
 * graders that need the output fail on their own terms against null.
 */
function entryFor(snapshot: RunDirectorySnapshot, trace: Trace): Entry {
  const effective: EffectiveTraceAnnotations | undefined =
    snapshot.effectiveAnnotations[trace.traceId];
  const runRow = effective?.run ?? null;
  const test = testOf(runRow, trace.traceId);
  const record: EvalRecord = evalRecordFor(trace, snapshot.dir);
  const outputs = record.evalOutputs ?? [];
  const workdir = runDirPaths(snapshot.dir).workdirDir;
  const run: LoadedRun = {
    output: outputs.length === 0 ? null : (outputs[outputs.length - 1].value as Json),
    traceId: trace.traceId,
    workdir: fs.existsSync(workdir) ? workdir : "",
    record,
  };
  const humanFeedback = humanFeedbackFor(snapshot, trace.traceId);
  const graders = runRow !== null && runRow.kind === "run" ? runRow.graders : undefined;
  const harness = runRow !== null && runRow.kind === "run" ? runRow.harness : undefined;
  const ended = runRow !== null && runRow.kind === "run" ? runRow.ended : traceEnding(trace);
  if (ended === "ok") {
    return { test, run, humanFeedback, graders, harness };
  }
  const detail =
    runRow !== null && runRow.kind === "run" && runRow.error !== undefined
      ? `: ${runRow.error}`
      : "";
  return {
    test,
    humanFeedback,
    graders,
    harness,
    ungradedReason: `the run ended with ${ended}${detail}`,
  };
}

/** The test a trace ran, from the harness's `run` row; an ad-hoc trace with
 *  no row is a test named by its trace id with no input on record. */
function testOf(runRow: Annotation | null, traceId: string): Test {
  if (runRow !== null && runRow.kind === "run" && isTestLike(runRow.test)) {
    return runRow.test;
  }
  return { id: traceId, input: "" };
}

function isTestLike(value: unknown): value is Test {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Grade one entry, or score it 0 when there is nothing gradable. */
async function gradeEntry(
  entry: Entry,
  ctx: GradingContext,
  graders: BaseGrader[],
): Promise<InputGrades> {
  if ("ungradedReason" in entry) {
    return {
      test: entry.test,
      run: null,
      grades: [],
      gatesPassed: false,
      ungradedReason: entry.ungradedReason,
      humanFeedback: entry.humanFeedback,
    };
  }
  const graded = await gradeInput(entry.test, entry.run, ctx, graders);
  return { ...graded, humanFeedback: entry.humanFeedback };
}

/**
 * Score one test. Gates run first and short-circuit the test the moment one
 * fails, so a failing gate never pays for the advisory graders behind it.
 */
async function gradeInput(
  test: Test,
  run: LoadedRun,
  ctx: GradingContext,
  graders: BaseGrader[],
): Promise<InputGrades> {
  const applicable = graders.filter((grader) => grader.gradesInput(test));
  const gates = applicable.filter((grader) => grader.mustPass());
  const advisory = applicable.filter((grader) => !grader.mustPass());

  const gateGrades: GraderGrade[] = [];
  for (const grader of gates) {
    const grade = await grader.run({ test, run, runAgency: ctx.runAgency });
    gateGrades.push({ grader, grade });
    if (!grader.passes(grade)) {
      return { test, run, grades: gateGrades, gatesPassed: false };
    }
  }

  const advisoryGrades = await Promise.all(
    advisory.map(async (grader) => ({
      grader,
      grade: await grader.run({ test, run, runAgency: ctx.runAgency }),
    })),
  );

  return { test, run, grades: [...gateGrades, ...advisoryGrades], gatesPassed: true };
}

function warn(message: string): void {
  console.warn(`grading: ${message}`);
}
