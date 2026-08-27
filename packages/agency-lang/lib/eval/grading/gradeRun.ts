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
import { LlmJudge } from "./graders/llmJudge.js";
import { AgencyTestGrader } from "./agencyTestGrader.js";
import { loadGradingModule, loadGradingSnapshot } from "./gradingModule.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./scorecard.js";
import type { GraderInput, LoadedRun, JSON as Json } from "./types.js";

/** Where each test's graders come from. Graders are test-side, like goal and
 *  expected: a test's own `graders.ts` and its harness pairs. The question
 *  is which copy.
 *  - "snapshot": the copy the run directory stored when the agent ran (the
 *    default; a run grades the same days later, wherever it is read).
 *  - "suite": the test's CURRENT graders in this loaded suite, matched by
 *    test id (`eval grade --suite`: improve a grader, re-score old runs
 *    without re-running the agent). A run whose test is not in the suite is
 *    an error, not a silent fallback.
 *  - "override": one set for every test, ignoring what the tests carry. The
 *    optimizer's objective; never a CLI option.
 *  A test with no graders of its own is scored by the bundled goal judge
 *  against its `goal`. */
export type GraderSource =
  | { kind: "snapshot" }
  | { kind: "suite"; tests: Test[] }
  | { kind: "override"; graders: BaseGrader[] };

/** What grading needs besides the run directory itself. */
export type GradingContext = {
  graders: GraderSource;
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
 * docs/dev/evals/eval-grading.md.)
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
      const { graders, graderFiles } = await effectiveGraders(
        entry,
        ctx,
        moduleCache,
        snapshot.dir,
      );
      return gradeEntry(entry, ctx, graders, graderFiles);
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
    grader.validateInput(test);
  }
}

/** Which graders score this test, and which copy of its grader-only files
 *  they read: both from the source `ctx.graders` names. */
async function effectiveGraders(
  entry: Entry,
  ctx: GradingContext,
  cache: (modulePath: string) => Promise<BaseGrader[]>,
  runDir: string,
): Promise<{ graders: BaseGrader[]; graderFiles?: string }> {
  const source = ctx.graders;
  if (source.kind === "suite") {
    const test = suiteTestFor(entry, source.tests);
    const harness = liveHarnessGraders(test);
    return {
      graders: [...(await suiteModuleGraders(test, cache, harness.length > 0)), ...harness],
      graderFiles: test.graderFiles,
    };
  }
  // Harness graders and grader files are the test's own: an override leaves them.
  const harness = snapshotHarnessGraders(entry, runDir);
  const graderFiles = snapshotGraderFilesDir(entry, runDir);
  if (source.kind === "override") {
    return { graders: [...source.graders, ...harness], graderFiles };
  }
  return {
    graders: [
      ...(await snapshotModuleGraders(entry, ctx, cache, runDir, harness.length > 0)),
      ...harness,
    ],
    graderFiles,
  };
}

/** The run directory's stored copy of the test's `graderFiles/`. */
function snapshotGraderFilesDir(entry: Entry, runDir: string): string | undefined {
  if (entry.graderFiles === undefined) return undefined;
  const dir = path.join(runDirPaths(runDir).gradersDir, entry.graderFiles);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Grader files snapshot not found: ${dir} (recorded for test ${entry.test.id ?? "(no id)"}).`,
    );
  }
  return dir;
}

/** The bundled goal judge: what scores a test that carries no graders. */
function goalJudge(): BaseGrader[] {
  return [new LlmJudge({ name: "goal" })];
}

/** The module graders from the run directory. Precedence: the snapshot the
 *  directory stored > the test's recorded module path (a directory from
 *  before snapshots) > the goal judge. A test with harness pairs already has
 *  graders of its own, so the goal judge, which would demand a goal the test
 *  never needed, does not apply to it. Under `--goal` (`ctx.defaultGoal`) a
 *  snapshot that came from the old config fallback is set aside: the goal
 *  promises the goal judge. */
async function snapshotModuleGraders(
  entry: Entry,
  ctx: GradingContext,
  cache: (modulePath: string) => Promise<BaseGrader[]>,
  runDir: string,
  hasAgencyTests: boolean,
): Promise<BaseGrader[]> {
  const snapshot = entry.graders;
  if (snapshot !== undefined && snapshot.origin === "test") {
    return loadGradingSnapshot(runDirPaths(runDir).gradersDir, snapshot);
  }
  if (entry.test.graders !== undefined) {
    return cache(entry.test.graders);
  }
  if (hasAgencyTests) {
    return [];
  }
  if (snapshot !== undefined && ctx.defaultGoal === undefined) {
    return loadGradingSnapshot(runDirPaths(runDir).gradersDir, snapshot);
  }
  return goalJudge();
}

/** The suite test this run belongs to, by test id. */
function suiteTestFor(entry: Entry, tests: Test[]): Test {
  const id = entry.test.id;
  const test = tests.find((candidate) => candidate.id === id);
  if (test === undefined) {
    throw new Error(
      `Run for test "${id}" has no test with that id in the suite given by --suite ` +
        `(${tests.length} test(s) there: ${tests.map((candidate) => candidate.id).join(", ")}).`,
    );
  }
  return test;
}

/** The suite test's current module graders, loaded from its `graders` path. */
async function suiteModuleGraders(
  test: Test,
  cache: (modulePath: string) => Promise<BaseGrader[]>,
  hasAgencyTests: boolean,
): Promise<BaseGrader[]> {
  if (test.graders !== undefined) {
    return cache(test.graders);
  }
  return hasAgencyTests ? [] : goalJudge();
}

/** One grader per harness pair the suite test has now, over the suite's files. */
function liveHarnessGraders(test: Test): BaseGrader[] {
  return (test.agencyTests ?? []).map(
    (def) =>
      new AgencyTestGrader({
        name: def.name,
        agencyFile: def.agencyFile,
        testJsonFile: def.testJsonFile,
        ...(test.harnessMaxCost === undefined ? {} : { maxCost: test.harnessMaxCost }),
        ...(test.harnessMustPass === undefined ? {} : { mustPass: test.harnessMustPass }),
      }),
  );
}

/** One grader per harness record, over the run directory's stored copy. */
function snapshotHarnessGraders(entry: Entry, runDir: string): BaseGrader[] {
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
      agencyFile: path.join(gradersDir, record.agency),
      testJsonFile: path.join(gradersDir, record.json),
      ...(record.maxCost === undefined ? {} : { maxCost: record.maxCost }),
      ...(record.mustPass === undefined ? {} : { mustPass: record.mustPass }),
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
  /** The stored `graderFiles/` copy's name under `graders/`, from the run row. */
  graderFiles?: string;
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
  const graderFiles = runRow !== null && runRow.kind === "run" ? runRow.graderFiles : undefined;
  const ended = runRow !== null && runRow.kind === "run" ? runRow.ended : traceEnding(trace);
  if (ended === "ok") {
    return { test, run, humanFeedback, graders, harness, graderFiles };
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
    graderFiles,
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
  graderFiles: string | undefined,
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
  const graded = await gradeInput(entry.test, entry.run, ctx, graders, graderFiles);
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
  graderFiles: string | undefined,
): Promise<InputGrades> {
  const gates = graders.filter((grader) => grader.mustPass());
  const advisory = graders.filter((grader) => !grader.mustPass());
  const input: GraderInput = { test, run, runAgency: ctx.runAgency, graderFiles };

  const gateGrades: GraderGrade[] = [];
  for (const grader of gates) {
    const grade = await grader.run(input);
    gateGrades.push({ grader, grade });
    if (!grader.passes(grade)) {
      return { test, run, grades: gateGrades, gatesPassed: false };
    }
  }

  const advisoryGrades = await Promise.all(
    advisory.map(async (grader) => ({
      grader,
      grade: await grader.run(input),
    })),
  );

  return { test, run, grades: [...gateGrades, ...advisoryGrades], gatesPassed: true };
}

function warn(message: string): void {
  console.warn(`grading: ${message}`);
}
