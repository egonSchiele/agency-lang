import * as fs from "fs";

import {
  listRevisionVersions,
  prepareRevision,
  publishPendingRevision,
  readCurrentPointer,
  readRevision,
  syncChecklistDefinition,
  validateLineageContinuity,
  type NormalizedDefinition,
  type PendingRevision,
  type PrepareChecklistResult,
  type PublishRevisionResult,
} from "@/eval/label/checklist.js";
import { loadDraftFile, saveDraftFile, type Draft } from "@/eval/label/draft.js";
import type {
  Annotator,
  ChecklistRevision,
  DeepReadonly,
  FaultHook,
  Fields,
} from "@/eval/label/types.js";
import type { EvalRecord } from "@/eval/types.js";

import type { ChecklistAnnotation, EffectiveChecklistJudgement } from "./annotations.js";
import { evalRecordFor } from "./evalRecord.js";
import type { RunDirLock } from "./lock.js";
import { appendAnnotationsUnderLock } from "./mutations.js";
import { readRunDirectory, runDirPaths, type RunDirectorySnapshot } from "./runDir.js";
import type { Trace } from "./traces.js";
import { traceInputText, traceOutputText } from "./traceText.js";

/**
 * What a labeling session may do to a run directory, and nothing more.
 *
 * The store exposes no file paths, no mutable rows and no unrestricted append:
 * those are how the sign-off ordering gets bypassed. It hands out read-only
 * projections and whole idempotent operations. The session holds the writer
 * lock for its whole life (two sessions on one directory would race for the
 * same revision number and share a draft file), so appends here go through
 * the run directory's lock-holding append rather than a public mutation.
 */
export class LabelStoreValidationError extends Error {}

export type OpenLabelStoreArgs = {
  dir: string;
  lock: RunDirLock;
  reportWarning(message: string): void;
  /** @internal Test-only interruption points inside multi-file operations. */
  fault?: FaultHook;
};

/** One trace as the screen shows it. */
export type LabelStoreItem = { traceId: string; fields: Fields };

export type LabelSessionIdentity = {
  sessionId: string;
  checklistId: string;
  annotator: Annotator;
};

/** What one session needs to reconstruct itself: its own in-progress draft if
 *  there is one, and this annotator's folded answers on this checklist. */
export type LabelStoreSessionSnapshot = {
  draft: DeepReadonly<Draft> | null;
  judgements: Readonly<Record<string, EffectiveChecklistJudgement>>;
};

export type LabelStore = {
  items(): readonly LabelStoreItem[];
  readSession(identity: LabelSessionIdentity): LabelStoreSessionSnapshot;
  saveDraft(draft: Draft): void;
  prepareChecklist(definition: NormalizedDefinition): PrepareChecklistResult;
  syncChecklistDefinition(definitionPath: string, revision: ChecklistRevision): void;
  publishRevision(pending: PendingRevision, definitionPath: string): PublishRevisionResult;
  /** Append a completed checklist row exactly as given. Idempotent: a row
   *  whose id is already on disk is a replay. */
  appendAnnotation(row: ChecklistAnnotation): "appended" | "replayed";
  close(): void;
};

/** The field the screen shows when a trace recorded no output. Its text is
 *  marked so nobody mistakes a mid-conversation message for the result. */
export const LAST_MESSAGE_FIELD = "last_message";
const LAST_MESSAGE_MARKER = "(no recorded output; this is the agent's last message)\n\n";

/**
 * Open a run directory for labeling, validating what labeling depends on
 * before returning: every checklist lineage is contiguous and unedited, and
 * every existing checklist row names a revision that exists with the hash it
 * recorded. Validation is fatal here where grading is tolerant, because a
 * label is the one artifact nothing can regenerate: a checklist row that
 * points at a missing revision would be labelled around forever.
 */
export function openLabelStore(args: OpenLabelStoreArgs): LabelStore {
  const paths = runDirPaths(args.dir);
  let snapshot = readRunDirectory(args.dir, { reportWarning: args.reportWarning });
  validateChecklists(args.dir, snapshot, args.reportWarning);

  const knownTraces: Record<string, true> = Object.create(null);
  for (const trace of snapshot.traces) knownTraces[trace.traceId] = true;

  let open = true;
  const assertOpen = (): void => {
    if (!open) throw new LabelStoreValidationError("This label store has been closed");
  };

  return {
    items(): readonly LabelStoreItem[] {
      assertOpen();
      return snapshot.traces.map((trace) => {
        const record = evalRecordFor(trace, paths.statelog);
        return { traceId: trace.traceId, fields: fieldsOf(trace, record) };
      });
    },

    readSession(identity: LabelSessionIdentity): LabelStoreSessionSnapshot {
      assertOpen();
      const key = `${identity.checklistId}:${identity.annotator.kind}:${identity.annotator.id}`;
      const judgements: Record<string, EffectiveChecklistJudgement> = {};
      for (const [traceId, effective] of Object.entries(snapshot.effectiveAnnotations)) {
        const judgement = effective.checklists[key];
        if (judgement !== undefined) judgements[traceId] = judgement;
      }
      return {
        draft: loadDraftFile(args.dir, identity.checklistId, identity.sessionId) ?? null,
        judgements,
      };
    },

    saveDraft(draft: Draft): void {
      assertOpen();
      saveDraftFile(args.dir, draft);
    },

    prepareChecklist(definition: NormalizedDefinition): PrepareChecklistResult {
      assertOpen();
      const pointer = readCurrentPointer(args.dir, definition.checklistId);
      const current =
        pointer === undefined
          ? undefined
          : readRevision(args.dir, definition.checklistId, pointer.version);
      return prepareRevision({ definition, current });
    },

    syncChecklistDefinition(definitionPath: string, revision: ChecklistRevision): void {
      assertOpen();
      syncChecklistDefinition({ definitionPath, revision });
    },

    publishRevision(pending: PendingRevision, definitionPath: string): PublishRevisionResult {
      assertOpen();
      return publishPendingRevision({
        dir: args.dir,
        pending,
        definitionPath,
        fault: args.fault,
      });
    },

    appendAnnotation(row: ChecklistAnnotation): "appended" | "replayed" {
      assertOpen();
      assertRowIsGrounded(args.dir, knownTraces, row);
      const before = snapshot.annotationRows.length;
      const { v: _v, id: _id, createdAt, ...draft } = row;
      appendAnnotationsUnderLock(args.dir, [draft], {
        now: () => createdAt,
        reportWarning: args.reportWarning,
      });
      args.fault?.("after-annotation-append");
      snapshot = readRunDirectory(args.dir, { reportWarning: args.reportWarning });
      return snapshot.annotationRows.length > before ? "appended" : "replayed";
    },

    close(): void {
      open = false;
      args.lock.release();
    },
  };
}

// --- projection -----------------------------------------------------------

function fieldsOf(trace: Trace, record: EvalRecord): Fields {
  const fields: Fields = {};
  const input = traceInputText(trace, record);
  if (input !== null) fields.input = input;
  const output = traceOutputText(trace, record);
  if (output.kind === "output") {
    fields.output = output.text;
  } else if (output.kind === "lastMessage") {
    fields[LAST_MESSAGE_FIELD] = LAST_MESSAGE_MARKER + output.text;
  }
  return fields;
}

// --- validation -----------------------------------------------------------

/** Every cross-file invariant labeling relies on, checked once at open. */
function validateChecklists(
  dir: string,
  snapshot: RunDirectorySnapshot,
  reportWarning: (message: string) => void,
): void {
  const revisionCache: Record<string, ChecklistRevision> = Object.create(null);
  const readCached = (checklistId: string, version: number): ChecklistRevision => {
    const key = `${checklistId}@${version}`;
    revisionCache[key] ??= readRevision(dir, checklistId, version);
    return revisionCache[key];
  };

  const checklistIds: string[] = [];
  for (const row of snapshot.annotationRows) {
    if (row.kind === "checklist" && !checklistIds.includes(row.checklist)) {
      checklistIds.push(row.checklist);
    }
  }
  const checklistsDir = runDirPaths(dir).checklistsDir;
  if (fs.existsSync(checklistsDir)) {
    for (const entry of fs.readdirSync(checklistsDir)) {
      if (!checklistIds.includes(entry)) checklistIds.push(entry);
    }
  }
  for (const checklistId of checklistIds) {
    validateLineage(dir, checklistId, readCached, reportWarning);
  }

  for (const row of snapshot.annotationRows) {
    if (row.kind !== "checklist") continue;
    let revision: ChecklistRevision;
    try {
      revision = readCached(row.checklist, row.version);
    } catch (error) {
      throw new LabelStoreValidationError(
        `Annotation "${row.id}" refers to checklist revision ${row.checklist}@${row.version}, ` +
          `which is missing: ${(error as Error).message}`,
      );
    }
    assertRowMatchesRevision(row, revision);
  }
}

function validateLineage(
  dir: string,
  checklistId: string,
  readCached: (checklistId: string, version: number) => ChecklistRevision,
  reportWarning: (message: string) => void,
): void {
  const versions = listRevisionVersions(dir, checklistId);
  if (versions.length === 0) return;
  // readRevision proves path/content agreement and recomputes the hash;
  // validateLineageContinuity proves the chain is contiguous and that every
  // adjacent pair obeys the same evolution rules publication enforces.
  try {
    validateLineageContinuity(dir, checklistId, versions);
  } catch (error) {
    throw new LabelStoreValidationError((error as Error).message);
  }
  const pointer = readCurrentPointer(dir, checklistId);
  if (pointer === undefined) {
    throw new LabelStoreValidationError(
      `Checklist "${checklistId}" has ${versions.length} revision(s) but no current pointer.`,
    );
  }
  const newest = versions[versions.length - 1];
  if (pointer.version > newest) {
    throw new LabelStoreValidationError(
      `Checklist "${checklistId}" current points at version ${pointer.version}, which has no ` +
        `stored revision. The newest is ${newest}.`,
    );
  }
  if (pointer.hash !== readCached(checklistId, pointer.version).hash) {
    throw new LabelStoreValidationError(
      `Checklist "${checklistId}" current records hash ${pointer.hash}, which does not match ` +
        `revision ${pointer.version}.`,
    );
  }
  // A pointer that LAGS is recoverable, not corrupt: it is exactly what a
  // crash between the immutable rename and the pointer update leaves behind.
  // Refusing to open here would make that state permanently unrepairable,
  // since recovery runs after the store opens.
  if (pointer.version < newest) {
    reportWarning(
      `Checklist "${checklistId}" has revisions up to ${newest} but current points at ` +
        `${pointer.version}, which means a publication was interrupted. Reopening a session on ` +
        `this checklist completes it.`,
    );
  }
}

/** A row's hash must be the revision's, and every answered question must be
 *  one that revision defines; otherwise the per-question fold would be
 *  reading answers nobody could have given. */
function assertRowMatchesRevision(row: ChecklistAnnotation, revision: ChecklistRevision): void {
  if (revision.hash !== row.hash) {
    throw new LabelStoreValidationError(
      `Annotation "${row.id}" records checklist hash ${row.hash}, but revision ` +
        `${row.checklist}@${row.version} hashes to ${revision.hash}.`,
    );
  }
  const known: Record<string, true> = Object.create(null);
  for (const question of revision.questions) known[question.id] = true;
  for (const questionId of Object.keys(row.answers)) {
    if (known[questionId] !== true) {
      throw new LabelStoreValidationError(
        `Annotation "${row.id}" answers question "${questionId}", which revision ` +
          `${row.checklist}@${row.version} does not define.`,
      );
    }
  }
}

/** Refuse a row for a trace the directory does not hold, or against a
 *  revision that is not on disk as recorded, so no caller can skip the
 *  capture-before-label and publish-before-append orders. */
function assertRowIsGrounded(
  dir: string,
  knownTraces: Record<string, true>,
  row: ChecklistAnnotation,
): void {
  if (knownTraces[row.traceId] !== true) {
    throw new LabelStoreValidationError(
      `Cannot record a judgement of trace "${row.traceId}": it is not in ${dir}.`,
    );
  }
  assertRowMatchesRevision(row, readRevision(dir, row.checklist, row.version));
}
