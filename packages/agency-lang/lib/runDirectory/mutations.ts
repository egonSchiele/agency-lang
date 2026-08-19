import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import { readRevision } from "@/eval/label/checklist.js";
import type { ChecklistRevision } from "@/eval/label/types.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";

import { appendDurably } from "./durableWrite.js";

import {
  completeAnnotation,
  readAnnotations,
  type Annotation,
  type AnnotationDraft,
  type Annotator,
  type ChecklistAnnotation,
  type RunPayload,
  type Score,
} from "./annotations.js";
import {
  applyCodeAttachment,
  CodeMismatchError,
  planCodeAttachment,
  recordedClosureHashes,
  type CodeAttachmentPlan,
} from "./attachCode.js";
import { computeCodeIdentity } from "./codeIdentity.js";
import {
  applyWorkdirAttachment,
  planWorkdirAttachment,
  type WorkdirAttachmentRequest,
  type WorkdirAttachmentPlan,
} from "./attachWorkdir.js";
import { acquireRunDirLock } from "./lock.js";
import {
  applyStatelogMerge,
  describeStatelogMerge,
  planStatelogMerge,
  type StatelogMergePlan,
} from "./mergeStatelog.js";
import {
  readRunDirectory,
  runDirPaths,
  type RunDirectoryPaths,
  type RunDirectorySnapshot,
} from "./runDir.js";
import { matchTrace, readTracesOrThrow, type Trace } from "./traces.js";

/**
 * The public writes on a run directory. Each operation describes a domain
 * change; the lock, the preflight, the torn-tail repair, and the order of
 * writes are this module's business and nobody else's. Every operation:
 *
 *   1. takes the writer lock,
 *   2. reads one snapshot,
 *   3. plans the WHOLE request with the pure planners — any refusal throws
 *      before a byte is written,
 *   4. repairs a torn final line on each append target,
 *   5. applies, then re-reads and returns the fresh snapshot,
 *   6. releases the lock, on success or failure.
 */
export type { WorkdirAttachmentRequest };

export type MutationOptions = {
  reportWarning?(message: string): void;
  /** Injected clock for tests. */
  now?(): string;
};

// --- wrapTracesAsRunDirectories --------------------------------------------

export type WrapTracesRequest = {
  /** The group directory; one `<groupDir>/<traceId>/` is written per trace. */
  groupDir: string;
  statelogFiles: string[];
  /** Keep only this trace (full id or unique prefix). */
  trace?: string;
  codeEntries: string[];
  workdir?: WorkdirAttachmentRequest;
  annotationFiles: string[];
};

export type WrapTracesResult = {
  written: string[];
  skipped: { traceId: string; reason: string }[];
};

type RunDirectoryAssemblyPlan = {
  dir: string;
  statelog: StatelogMergePlan;
  code: CodeAttachmentPlan[];
  workdir?: WorkdirAttachmentPlan;
  annotationDrafts: AnnotationDraft[];
};

type WrappedRunPlan = {
  childDir: string;
  stagingDir: string;
  assembly: RunDirectoryAssemblyPlan;
};

type WrapTracesPlan = {
  stagingRoot: string;
  writes: WrappedRunPlan[];
  skipped: { traceId: string; reason: string }[];
};

/**
 * `agency runs add` and `agency run --capture-workdir`: make one run directory
 * per trace in the given statelogs, under `groupDir`. Each child is assembled
 * below `<groupDir>/.staging/` and renamed into place, so a child is
 * either whole or absent. A child that already exists is skipped, never
 * touched. Code is attached to the traces that recorded its closure hash and
 * must match at least one; annotation rows go to the child their `traceId`
 * names and must each name one of the traces.
 */
export function wrapTracesAsRunDirectories(
  request: WrapTracesRequest,
  options: MutationOptions = {},
): WrapTracesResult {
  const plan = planWrappedRuns(request, options);
  return applyWrappedRuns(plan, options);
}

/** Resolve and validate every child before creating the group or staging any
 *  run. The executor therefore receives only complete, writable requests. */
function planWrappedRuns(request: WrapTracesRequest, options: MutationOptions): WrapTracesPlan {
  const reportWarning = options.reportWarning ?? (() => {});
  const traces = selectTraces(request);
  if (request.workdir !== undefined && traces.length > 1) {
    throw new Error(
      `--workdir needs --trace <id>: the statelog holds ${traces.length} traces ` +
        `(${traces.map((trace) => trace.traceId).join(", ")}).`,
    );
  }
  const annotationDrafts = request.annotationFiles.flatMap((file) =>
    readAnnotations(file, reportWarning).map(draftOf),
  );
  const ids = traces.map((trace) => trace.traceId);
  const orphan = annotationDrafts.find((draft) => !ids.includes(draft.traceId));
  if (orphan !== undefined) {
    throw new Error(
      `An annotation row names trace ${orphan.traceId}, which is not among the traces being ` +
        `wrapped (${ids.join(", ")}). Nothing was written.`,
    );
  }
  const codeIdentities = request.codeEntries.map((entry) => ({
    entry,
    hash: computeCodeIdentity(entry).closureHash,
  }));
  const recordedAnywhere = recordedClosureHashes(traces);
  const unmatchedCode = codeIdentities.find((code) => !recordedAnywhere.includes(code.hash));
  if (unmatchedCode !== undefined) {
    const known = recordedAnywhere.length === 0 ? "none recorded" : recordedAnywhere.join(", ");
    throw new CodeMismatchError(
      `${unmatchedCode.entry} hashes to ${unmatchedCode.hash}, which none of the traces recorded ` +
        `as its code (${known}). Attach the code that actually ran.`,
    );
  }

  const groupDir = path.resolve(request.groupDir);
  const stagingRoot = path.join(groupDir, ".staging");
  const children = traces.map((trace) => {
    const childDir = childDirFor(groupDir, trace.traceId);
    return { trace, childDir, exists: fs.existsSync(childDir) };
  });
  const skipped = children
    .filter((child) => child.exists)
    .map(({ trace, childDir }) => ({
      traceId: trace.traceId,
      reason: `${childDir} already exists`,
    }));
  const writes = children
    .filter((child) => !child.exists)
    .map(({ trace, childDir }) => {
      const stagingDir = path.join(stagingRoot, nanoid());
      const recorded = recordedClosureHashes([trace]);
      return {
        childDir,
        stagingDir,
        assembly: planRunDirectoryAssembly({
          dir: stagingDir,
          trace,
          codeEntries: codeIdentities
            .filter((code) => recorded.includes(code.hash))
            .map((code) => code.entry),
          workdir: request.workdir,
          annotationDrafts: annotationDrafts.filter((draft) => draft.traceId === trace.traceId),
        }),
      };
    });
  return { stagingRoot, writes, skipped };
}

/** The traces the request is about, with the same id never carrying two
 *  different event streams, and narrowed to `--trace` when given. */
function selectTraces(request: WrapTracesRequest): Trace[] {
  const incoming = request.statelogFiles.flatMap(readTracesOrThrow);
  const plan = planStatelogMerge([], incoming);
  if (plan.refused.length > 0) {
    const ids = plan.refused.map((refusal) => refusal.traceId).join(", ");
    throw new Error(
      `Trace id(s) ${ids} appear more than once with different content. Nothing was written.`,
    );
  }
  if (request.trace === undefined) return plan.add;
  const match = matchTrace(plan.add, request.trace);
  if (match.kind === "one") return [match.trace];
  if (match.kind === "none") throw new Error(`No trace matches ${request.trace}.`);
  throw new Error(`--trace ${request.trace} is ambiguous: ${match.ids.join(", ")}.`);
}

/** `<groupDir>/<traceId>`, refusing an id that would land outside the group. */
function childDirFor(groupDir: string, traceId: string): string {
  const child = path.resolve(groupDir, traceId);
  if (path.dirname(child) !== path.resolve(groupDir)) {
    throw new Error(
      `Refusing to write trace "${traceId}": its id would place the run directory outside ` +
        `${groupDir}.`,
    );
  }
  if (child === path.join(path.resolve(groupDir), ".staging")) {
    throw new Error(`Refusing to write trace "${traceId}": .staging is reserved for assembly.`);
  }
  return child;
}

function planRunDirectoryAssembly(args: {
  dir: string;
  trace: Trace;
  codeEntries: string[];
  workdir?: WorkdirAttachmentRequest;
  annotationDrafts: AnnotationDraft[];
}): RunDirectoryAssemblyPlan {
  const paths = runDirPaths(args.dir);
  const snapshot: RunDirectorySnapshot = {
    dir: args.dir,
    hasStatelog: false,
    traces: [args.trace],
    annotationRows: [],
    effectiveAnnotations: {},
    notes: null,
  };
  return {
    dir: args.dir,
    statelog: planStatelogMerge([], [args.trace]),
    code: args.codeEntries.map((entry) => planCodeAttachment(snapshot, entry, paths)),
    workdir:
      args.workdir === undefined ? undefined : planWorkdirAttachment(snapshot, args.workdir, paths),
    annotationDrafts: args.annotationDrafts,
  };
}

function applyWrappedRuns(plan: WrapTracesPlan, options: MutationOptions): WrapTracesResult {
  const result: WrapTracesResult = { written: [], skipped: plan.skipped };
  try {
    for (const run of plan.writes) {
      fs.mkdirSync(plan.stagingRoot, { recursive: true });
      fs.mkdirSync(run.stagingDir);
      try {
        applyRunDirectoryAssembly(run.assembly, options);
        fs.renameSync(run.stagingDir, run.childDir);
        result.written.push(run.childDir);
      } catch (error) {
        removeStagedRun(plan.stagingRoot, run.stagingDir);
        throw error;
      }
    }
  } finally {
    removeEmptyDirectory(plan.stagingRoot);
  }
  return result;
}

function applyRunDirectoryAssembly(plan: RunDirectoryAssemblyPlan, options: MutationOptions): void {
  withWriter(plan.dir, options, (paths, _snapshot, reportWarning) => {
    applyStatelogMerge(paths, plan.statelog);
    for (const codePlan of plan.code) {
      applyCodeAttachment(paths, codePlan);
    }
    if (plan.workdir !== undefined) {
      applyWorkdirAttachment(paths, plan.workdir, now(options));
    }
    appendRows(paths.annotations, plan.annotationDrafts, options, reportWarning);
    return {};
  });
}

function removeStagedRun(stagingRoot: string, stagingDir: string): void {
  if (!fs.existsSync(stagingDir)) {
    return;
  }
  const deleted = safeDeleteDirectoryWithin(stagingRoot, stagingDir);
  if (!deleted.success) {
    throw new Error(deleted.message ?? `Could not remove ${stagingDir}.`);
  }
}

function removeEmptyDirectory(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      throw error;
    }
  }
}

// --- recordCompletedRun ---------------------------------------------------

export type RunAnnotationDraft = { traceId: string; annotator: Annotator; payload: RunPayload };

export type RecordCompletedRunRequest = {
  dir: string;
  /** Absent when the run never wrote a statelog; the `run` row is still
   *  recorded so the failure is not lost. */
  stagedStatelogFile?: string;
  codeEntry?: string;
  workdir?: WorkdirAttachmentRequest;
  /** Files to store under `graders/` (content-hash names); the run row's
   *  `graders` field says what they are. */
  gradersFiles?: { name: string; content: string }[];
  run: RunAnnotationDraft;
};

export type RecordCompletedRunResult = { annotation: Annotation; snapshot: RunDirectorySnapshot };

/** The eval harness's one call per finished test, on a fresh directory:
 *  write the staged statelog, attach code and workdir, append the `run` row. */
export function recordCompletedRun(
  request: RecordCompletedRunRequest,
  options: MutationOptions = {},
): RecordCompletedRunResult {
  return withWriter(request.dir, options, (paths, snapshot, reportWarning) => {
    const incoming =
      request.stagedStatelogFile === undefined ? [] : readTracesOrThrow(request.stagedStatelogFile);
    const statelogPlan = planStatelogMerge(snapshot.traces, incoming);
    if (statelogPlan.refused.length > 0) {
      throw new Error(describeStatelogMerge(statelogPlan, request.dir));
    }
    const merged: RunDirectorySnapshot = {
      ...snapshot,
      traces: [...snapshot.traces, ...statelogPlan.add],
    };
    assertOneRunPlanned(request.dir, snapshot, merged, request.run.traceId);
    const codePlan =
      request.codeEntry === undefined
        ? undefined
        : planCodeAttachment(merged, request.codeEntry, paths);
    const workdirPlan =
      request.workdir === undefined
        ? undefined
        : planWorkdirAttachment(merged, request.workdir, paths);
    const draft: AnnotationDraft = {
      traceId: request.run.traceId,
      annotator: request.run.annotator,
      ...request.run.payload,
    };

    applyStatelogMerge(paths, statelogPlan);
    if (codePlan !== undefined) applyCodeAttachment(paths, codePlan);
    if (workdirPlan !== undefined) applyWorkdirAttachment(paths, workdirPlan, now(options));
    if (request.gradersFiles !== undefined) writeGradersFiles(paths, request.gradersFiles);
    const [annotation] = appendRows(paths.annotations, [draft], options, reportWarning);
    return { annotation };
  });
}

/** Content-hash names never collide on different contents; the same name
 *  already present is the same file, so nothing is rewritten. */
function writeGradersFiles(
  paths: RunDirectoryPaths,
  files: readonly { name: string; content: string }[],
): void {
  fs.mkdirSync(paths.gradersDir, { recursive: true });
  for (const file of files) {
    const target = path.join(paths.gradersDir, file.name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, file.content);
  }
}

/**
 * A run directory holds one run; refuse, before a byte is written, anything
 * that would make it hold two. The post-write read would catch a second trace
 * too, but by then the statelog is already the forbidden shape.
 *
 * - the merged trace set has at most one id;
 * - when a trace exists, the run row names it (also when nothing was staged:
 *   a run row for another trace would record a second run here);
 * - when no trace exists, only one silent run may be recorded: a run row
 *   already on disk for a different trace is a different run.
 */
function assertOneRunPlanned(
  dir: string,
  snapshot: RunDirectorySnapshot,
  merged: RunDirectorySnapshot,
  runTraceId: string,
): void {
  if (merged.traces.length > 1) {
    const ids = merged.traces.map((trace) => trace.traceId).join(", ");
    throw new Error(
      `Cannot record run for trace ${runTraceId}: ${dir} would then hold ${merged.traces.length} ` +
        `traces (${ids}), and a run directory holds one run. Nothing was written.`,
    );
  }
  const [trace] = merged.traces;
  if (trace !== undefined && trace.traceId !== runTraceId) {
    throw new Error(
      `Cannot record run for trace ${runTraceId}: ${dir} holds trace ${trace.traceId}, and a ` +
        `run directory holds one run. Nothing was written.`,
    );
  }
  if (trace === undefined) {
    const other = Object.keys(snapshot.effectiveAnnotations).find(
      (traceId) => traceId !== runTraceId && snapshot.effectiveAnnotations[traceId].run !== null,
    );
    if (other !== undefined) {
      throw new Error(
        `Cannot record run for trace ${runTraceId}: ${dir} already records the run of trace ` +
          `${other}, and a run directory holds one run. Nothing was written.`,
      );
    }
  }
}

// --- recordGradingPass ----------------------------------------------------

export type ScoreDraft = {
  traceId: string;
  annotator: Annotator;
  name: string;
  score: Score;
  weight: number;
  mustPass: boolean;
  feedback?: string;
  gradersModule?: string;
  goal?: string;
};

export type RecordGradingPassRequest = { dir: string; scores: ScoreDraft[] };

export type RecordGradingPassResult = {
  passId: string;
  annotations: Annotation[];
  snapshot: RunDirectorySnapshot;
};

/** One grading pass: every score draft gets the same fresh `passId` and the
 *  pass size. A crash before the last row leaves an incomplete pass the fold
 *  ignores. */
export function recordGradingPass(
  request: RecordGradingPassRequest,
  options: MutationOptions = {},
): RecordGradingPassResult {
  if (request.scores.length === 0) {
    throw new Error("A grading pass needs at least one score; nothing was recorded.");
  }
  const passId = newPassId();
  const result = withWriter(request.dir, options, (paths, snapshot, reportWarning) => {
    const known: Record<string, true> = Object.create(null);
    for (const trace of snapshot.traces) known[trace.traceId] = true;
    const unknown = request.scores.find((score) => !known[score.traceId]);
    if (unknown !== undefined) {
      throw new Error(`No trace ${unknown.traceId} in ${request.dir}; nothing was recorded.`);
    }
    const drafts: AnnotationDraft[] = request.scores.map((score) => {
      const draft: AnnotationDraft = {
        traceId: score.traceId,
        annotator: score.annotator,
        kind: "score",
        passId,
        passSize: request.scores.length,
        name: score.name,
        score: score.score,
        weight: score.weight,
        mustPass: score.mustPass,
      };
      if (score.feedback !== undefined) draft.feedback = score.feedback;
      if (score.gradersModule !== undefined) draft.gradersModule = score.gradersModule;
      if (score.goal !== undefined) draft.goal = score.goal;
      return draft;
    });
    return { annotations: appendRows(paths.annotations, drafts, options, reportWarning) };
  });
  return { passId, annotations: result.annotations, snapshot: result.snapshot };
}

export function newPassId(): string {
  return `pass_${nanoid()}`;
}

// --- recordChecklistRow ---------------------------------------------------

export type RecordChecklistRowRequest = {
  dir: string;
  /** The group the run belongs to: where the checklist lineage lives. */
  groupDir: string;
  row: ChecklistAnnotation;
};

export type RecordChecklistRowResult = {
  outcome: "appended" | "replayed";
  snapshot: RunDirectorySnapshot;
};

/** One labeling sign-off on one run: the row exactly as the session built it
 *  (its id is already derived from its content, so a replay lands on the same
 *  id), grounded against the run and the group's lineage immediately before an
 *  idempotent append under the run's lock. */
export function recordChecklistRow(
  request: RecordChecklistRowRequest,
  options: MutationOptions = {},
): RecordChecklistRowResult {
  const result = withWriter(request.dir, options, (paths, snapshot, reportWarning) => {
    assertChecklistRowGrounded(request.dir, request.groupDir, snapshot, request.row);
    // Under the lock nobody else appends, so "already on disk" is the whole
    // replay test; the id is content-derived, so a rebuilt row matches too.
    const replayed = snapshot.annotationRows.some((row) => row.id === request.row.id);
    const { v: _v, id: _id, createdAt, ...draft } = request.row;
    appendRows(paths.annotations, [draft], { ...options, now: () => createdAt }, reportWarning);
    const outcome: RecordChecklistRowResult["outcome"] = replayed ? "replayed" : "appended";
    return { outcome };
  });
  return { outcome: result.outcome, snapshot: result.snapshot };
}

/** Refuse a row for a trace the run does not hold, or against a revision that
 *  is not in the group's lineage as recorded, or answering a question that
 *  revision does not define: no caller can skip capture-before-label or
 *  publish-before-append. The immutable revision file is the grounding fact;
 *  the current pointer may move on without changing what an older row means. */
function assertChecklistRowGrounded(
  dir: string,
  groupDir: string,
  snapshot: RunDirectorySnapshot,
  row: ChecklistAnnotation,
): void {
  if (!snapshot.traces.some((trace) => trace.traceId === row.traceId)) {
    throw new Error(`Cannot record a judgement of trace "${row.traceId}": it is not in ${dir}.`);
  }
  let revision: ChecklistRevision;
  try {
    revision = readRevision(groupDir, row.checklist, row.version);
  } catch (error) {
    throw new Error(
      `Annotation "${row.id}" refers to checklist revision ${row.checklist}@${row.version}, ` +
        `which is missing from ${groupDir}: ${(error as Error).message}`,
    );
  }
  assertRowMatchesRevision(row, revision);
}

/** A row's hash must be the revision's, and every answered question must be
 *  one that revision defines; otherwise the per-question fold would be
 *  reading answers nobody could have given. */
export function assertRowMatchesRevision(
  row: ChecklistAnnotation,
  revision: ChecklistRevision,
): void {
  if (revision.hash !== row.hash) {
    throw new Error(
      `Annotation "${row.id}" records checklist hash ${row.hash}, but revision ` +
        `${row.checklist}@${row.version} hashes to ${revision.hash}.`,
    );
  }
  const known: Record<string, true> = Object.create(null);
  for (const question of revision.questions) known[question.id] = true;
  for (const questionId of Object.keys(row.answers)) {
    if (known[questionId] !== true) {
      throw new Error(
        `Annotation "${row.id}" answers question "${questionId}", which revision ` +
          `${row.checklist}@${row.version} does not define.`,
      );
    }
  }
}

// --- private machinery ----------------------------------------------------

type Writer<T> = (
  paths: ReturnType<typeof runDirPaths>,
  snapshot: RunDirectorySnapshot,
  reportWarning: (message: string) => void,
) => T;

function withWriter<T>(
  dir: string,
  options: MutationOptions,
  write: Writer<T>,
): T & { snapshot: RunDirectorySnapshot } {
  const reportWarning = options.reportWarning ?? (() => {});
  const lock = acquireRunDirLock({ dir, reportWarning });
  try {
    const paths = runDirPaths(dir);
    repairTornTail(paths.statelog);
    repairTornTail(paths.annotations);
    const snapshot = readRunDirectory(dir, { reportWarning });
    const result = write(paths, snapshot, reportWarning);
    return { ...result, snapshot: readRunDirectory(dir, { reportWarning }) };
  } finally {
    lock.release();
  }
}

/** A crash mid-append leaves a final line without its newline. Readers ignore
 *  it; a writer must remove it before appending, or the next row would be
 *  glued onto the fragment and both would be lost. */
function repairTornTail(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  if (text.length === 0 || text.endsWith("\n")) return;
  const keep = text.slice(0, text.lastIndexOf("\n") + 1);
  const handle = fs.openSync(filePath, "r+");
  try {
    fs.ftruncateSync(handle, Buffer.byteLength(keep, "utf8"));
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/** Append drafts as rows, skipping any whose id is already present (a retry),
 *  each as one durable line. Returns the rows as stored. */
function appendRows(
  annotationsPath: string,
  drafts: readonly AnnotationDraft[],
  options: MutationOptions,
  reportWarning: (message: string) => void,
): Annotation[] {
  const existing: Record<string, Annotation> = Object.create(null);
  for (const row of readAnnotations(annotationsPath, reportWarning)) existing[row.id] = row;
  const rows: Annotation[] = [];
  for (const draft of drafts) {
    const row = completeAnnotation(draft, now(options));
    const known = existing[row.id];
    if (known !== undefined) {
      rows.push(known);
      continue;
    }
    appendDurably(annotationsPath, JSON.stringify(row) + "\n");
    existing[row.id] = row;
    rows.push(row);
  }
  return rows;
}

function draftOf(row: Annotation): AnnotationDraft {
  const { v: _v, id: _id, createdAt: _createdAt, ...draft } = row;
  return draft;
}

function now(options: MutationOptions): string {
  return options.now === undefined ? new Date().toISOString() : options.now();
}

export type { CodeAttachmentPlan, StatelogMergePlan };
