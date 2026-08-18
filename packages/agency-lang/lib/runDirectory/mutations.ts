import * as fs from "fs";

import { nanoid } from "nanoid";

import { appendDurably } from "@/eval/label/jsonl.js";

import {
  completeAnnotation,
  readAnnotations,
  type Annotation,
  type AnnotationDraft,
  type Annotator,
  type RunPayload,
  type Score,
} from "./annotations.js";
import { applyCodeAttachment, planCodeAttachment, type CodeAttachmentPlan } from "./attachCode.js";
import {
  applyWorkdirAttachment,
  planWorkdirAttachment,
  type WorkdirAttachmentPlan,
  type WorkdirAttachmentRequest,
} from "./attachWorkdir.js";
import { acquireRunDirLock } from "./lock.js";
import { applyStatelogMerge, planStatelogMerge, type StatelogMergePlan } from "./mergeStatelog.js";
import { readRunDirectory, runDirPaths, type RunDirectorySnapshot } from "./runDir.js";
import { readTraces } from "./traces.js";

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

// --- addToRunDirectory ----------------------------------------------------

export type AddToRunDirectoryRequest = {
  dir: string;
  statelogFiles: string[];
  codeEntries: string[];
  workdir?: WorkdirAttachmentRequest;
  annotationFiles: string[];
};

export type MutationCounts = { added: number; skipped: number };

export type AddToRunDirectoryResult = {
  statelogs: MutationCounts;
  code: MutationCounts;
  workdirs: MutationCounts;
  annotations: MutationCounts;
  snapshot: RunDirectorySnapshot;
};

export function addToRunDirectory(
  request: AddToRunDirectoryRequest,
  options: MutationOptions = {},
): AddToRunDirectoryResult {
  return withWriter(request.dir, options, (paths, snapshot, reportWarning) => {
    // Plan everything first. Statelogs are planned as one incoming set so a
    // conflict in the third file also stops the first from being written.
    const incoming = request.statelogFiles.flatMap((file) => readTraces(file).traces);
    const statelogPlan = planStatelogMerge(snapshot.traces, incoming);
    if (statelogPlan.refused.length > 0) {
      const ids = statelogPlan.refused.map((refusal) => refusal.traceId).join(", ");
      throw new Error(
        `Refusing to merge: trace id(s) ${ids} already exist in ${request.dir} with different ` +
          `content. Nothing was written.`,
      );
    }
    // Code and workdir plans need the traces the statelogs are about to add,
    // so plan them against the merged view.
    const merged: RunDirectorySnapshot = {
      ...snapshot,
      traces: [...snapshot.traces, ...statelogPlan.add],
    };
    const codePlans = request.codeEntries.map((entry) => planCodeAttachment(merged, entry, paths));
    const workdirPlan =
      request.workdir === undefined
        ? undefined
        : planWorkdirAttachment(merged, request.workdir, paths);
    const annotationDrafts = request.annotationFiles.flatMap((file) =>
      readAnnotations(file, reportWarning).map(draftOf),
    );

    // Apply, in the order that keeps a crash recoverable: traces before the
    // things that point at them.
    applyStatelogMerge(paths, statelogPlan);
    for (const plan of codePlans) applyCodeAttachment(paths, plan);
    if (workdirPlan !== undefined) applyWorkdirAttachment(paths, workdirPlan, now(options));
    const annotationCounts = appendAnnotations(
      paths.annotations,
      annotationDrafts,
      options,
      reportWarning,
    );

    return {
      statelogs: { added: statelogPlan.add.length, skipped: statelogPlan.skipped.length },
      code: countPlans(codePlans.map((plan) => plan.status === "add")),
      workdirs: countWorkdir(workdirPlan),
      annotations: annotationCounts,
    };
  });
}

// --- recordCompletedRun ---------------------------------------------------

export type RunAnnotationDraft = { traceId: string; annotator: Annotator; payload: RunPayload };

export type RecordCompletedRunRequest = {
  dir: string;
  stagedStatelogFile: string;
  codeEntry?: string;
  workdir?: WorkdirAttachmentRequest;
  run: RunAnnotationDraft;
};

export type RecordCompletedRunResult = { annotation: Annotation; snapshot: RunDirectorySnapshot };

/** The eval harness's one call per finished test: merge the staged statelog,
 *  attach code and workdir, append the `run` row. */
export function recordCompletedRun(
  request: RecordCompletedRunRequest,
  options: MutationOptions = {},
): RecordCompletedRunResult {
  return withWriter(request.dir, options, (paths, snapshot, reportWarning) => {
    const incoming = readTraces(request.stagedStatelogFile).traces;
    const statelogPlan = planStatelogMerge(snapshot.traces, incoming);
    if (statelogPlan.refused.length > 0) {
      throw new Error(
        `Refusing to record run: trace ${statelogPlan.refused[0].traceId} already exists in ` +
          `${request.dir} with different content.`,
      );
    }
    const merged: RunDirectorySnapshot = {
      ...snapshot,
      traces: [...snapshot.traces, ...statelogPlan.add],
    };
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
      return draft;
    });
    return { annotations: appendRows(paths.annotations, drafts, options, reportWarning) };
  });
  return { passId, annotations: result.annotations, snapshot: result.snapshot };
}

export function newPassId(): string {
  return `pass_${nanoid()}`;
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

function appendAnnotations(
  annotationsPath: string,
  drafts: readonly AnnotationDraft[],
  options: MutationOptions,
  reportWarning: (message: string) => void,
): MutationCounts {
  const before = readAnnotations(annotationsPath, reportWarning).length;
  const rows = appendRows(annotationsPath, drafts, options, reportWarning);
  const after = readAnnotations(annotationsPath, reportWarning).length;
  return { added: after - before, skipped: rows.length - (after - before) };
}

function draftOf(row: Annotation): AnnotationDraft {
  const { v: _v, id: _id, createdAt: _createdAt, ...draft } = row;
  return draft;
}

function countPlans(added: boolean[]): MutationCounts {
  const count = added.filter(Boolean).length;
  return { added: count, skipped: added.length - count };
}

function countWorkdir(plan: WorkdirAttachmentPlan | undefined): MutationCounts {
  if (plan === undefined) return { added: 0, skipped: 0 };
  return { added: 1, skipped: 0 };
}

function now(options: MutationOptions): string {
  return options.now === undefined ? new Date().toISOString() : options.now();
}

export type { CodeAttachmentPlan, StatelogMergePlan };
