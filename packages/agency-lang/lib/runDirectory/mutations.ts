import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import { appendDurably } from "./durableWrite.js";

import {
  completeAnnotation,
  readAnnotations,
  type Annotation,
  type AnnotationDraft,
  type Annotator,
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
} from "./attachWorkdir.js";
import { acquireRunDirLock } from "./lock.js";
import {
  applyStatelogMerge,
  describeStatelogMerge,
  planStatelogMerge,
  type StatelogMergePlan,
} from "./mergeStatelog.js";
import { readRunDirectory, runDirPaths, type RunDirectorySnapshot } from "./runDir.js";
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

/**
 * `agency runs add` and `agency run --capture-workdir`: make one run directory
 * per trace in the given statelogs, under `groupDir`. Each child is assembled
 * in `<groupDir>/.staging/<traceId>` and renamed into place, so a child is
 * either whole or absent. A child that already exists is skipped, never
 * touched. Code is attached to the traces that recorded its closure hash and
 * must match at least one; annotation rows go to the child their `traceId`
 * names and must each name one of the traces.
 */
export function wrapTracesAsRunDirectories(
  request: WrapTracesRequest,
  options: MutationOptions = {},
): WrapTracesResult {
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
  for (const code of codeIdentities) {
    if (!recordedAnywhere.includes(code.hash)) {
      const known = recordedAnywhere.length === 0 ? "none recorded" : recordedAnywhere.join(", ");
      throw new CodeMismatchError(
        `${code.entry} hashes to ${code.hash}, which none of the traces recorded as its code ` +
          `(${known}). Attach the code that actually ran.`,
      );
    }
  }

  const result: WrapTracesResult = { written: [], skipped: [] };
  const stagingRoot = path.join(request.groupDir, ".staging");
  for (const trace of traces) {
    const child = childDirFor(request.groupDir, trace.traceId);
    if (fs.existsSync(child)) {
      result.skipped.push({ traceId: trace.traceId, reason: `${child} already exists` });
      continue;
    }
    const staging = path.join(stagingRoot, trace.traceId);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const recorded = recordedClosureHashes([trace]);
    assembleRunDirectory(
      {
        dir: staging,
        trace,
        codeEntries: codeIdentities
          .filter((code) => recorded.includes(code.hash))
          .map((code) => code.entry),
        workdir: request.workdir,
        annotationDrafts: annotationDrafts.filter((draft) => draft.traceId === trace.traceId),
      },
      options,
    );
    fs.renameSync(staging, child);
    result.written.push(child);
  }
  removeIfEmpty(stagingRoot);
  return result;
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
  return child;
}

/** Write one trace's statelog into `dir`, then attach code, workdir and rows
 *  under the directory's writer lock. */
function assembleRunDirectory(
  args: {
    dir: string;
    trace: Trace;
    codeEntries: string[];
    workdir?: WorkdirAttachmentRequest;
    annotationDrafts: AnnotationDraft[];
  },
  options: MutationOptions,
): void {
  withWriter(args.dir, options, (paths, snapshot, reportWarning) => {
    applyStatelogMerge(paths, planStatelogMerge(snapshot.traces, [args.trace]));
    const merged: RunDirectorySnapshot = { ...snapshot, traces: [args.trace] };
    const codePlans = args.codeEntries.map((entry) => planCodeAttachment(merged, entry, paths));
    const workdirPlan =
      args.workdir === undefined ? undefined : planWorkdirAttachment(merged, args.workdir, paths);
    for (const plan of codePlans) applyCodeAttachment(paths, plan);
    if (workdirPlan !== undefined) applyWorkdirAttachment(paths, workdirPlan, now(options));
    appendRows(paths.annotations, args.annotationDrafts, options, reportWarning);
    return {};
  });
}

function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty, or already gone — either is fine
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
    // A run that died before writing a single event has no trace, and its run
    // row is the only record it happened; that is allowed. But when the staged
    // statelog does hold traces, the run row must be about one of them (or one
    // already in the directory): otherwise the staged trace loses its
    // completion record and an orphan row points at nothing.
    const known = merged.traces.some((trace) => trace.traceId === request.run.traceId);
    if (incoming.length > 0 && !known) {
      const staged = incoming.map((trace) => trace.traceId).join(", ");
      throw new Error(
        `Cannot record run for trace ${request.run.traceId}: it is not in ${request.dir}, and ` +
          `the staged statelog holds ${staged} instead. Nothing was written.`,
      );
    }
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
    const [annotation] = appendRows(paths.annotations, [draft], options, reportWarning);
    return { annotation };
  });
}

// --- recordNote -----------------------------------------------------------

export type RecordNoteRequest = {
  dir: string;
  traceId: string;
  annotator: Annotator;
  text: string;
};

export function recordNote(request: RecordNoteRequest, options: MutationOptions = {}): Annotation {
  return withWriter(request.dir, options, (paths, snapshot, reportWarning) => {
    if (!snapshot.traces.some((trace) => trace.traceId === request.traceId)) {
      throw new Error(`No trace ${request.traceId} in ${request.dir}.`);
    }
    const draft: AnnotationDraft = {
      traceId: request.traceId,
      annotator: request.annotator,
      kind: "note",
      text: request.text,
    };
    const [annotation] = appendRows(paths.annotations, [draft], options, reportWarning);
    return { annotation };
  }).annotation;
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

/** One grading pass: every score draft gets the same fresh `passId`, the
 *  pass size, and `completesPass` on the final row only. A crash before that
 *  row leaves an incomplete pass the fold ignores. */
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
    const drafts: AnnotationDraft[] = request.scores.map((score, index) => {
      const draft: AnnotationDraft = {
        traceId: score.traceId,
        annotator: score.annotator,
        kind: "score",
        passId,
        passSize: request.scores.length,
        completesPass: index === request.scores.length - 1,
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

// --- appendAnnotationsUnderLock -------------------------------------------

/** @internal For a run-directory owner that already holds the writer lock for
 *  a whole session (the labeling store). Repairs a torn tail, then appends
 *  the drafts idempotently, exactly as the public mutations do. */
export function appendAnnotationsUnderLock(
  dir: string,
  drafts: readonly AnnotationDraft[],
  options: MutationOptions = {},
): Annotation[] {
  const reportWarning = options.reportWarning ?? (() => {});
  const paths = runDirPaths(dir);
  repairTornTail(paths.annotations);
  return appendRows(paths.annotations, drafts, options, reportWarning);
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
