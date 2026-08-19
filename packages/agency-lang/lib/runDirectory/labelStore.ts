import * as fs from "fs";
import * as path from "path";

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
import type { LabelingGroup, LabelingRun } from "@/eval/label/group.js";
import type {
  Annotator,
  ChecklistRevision,
  DeepReadonly,
  FaultHook,
  Fields,
} from "@/eval/label/types.js";

import type { ChecklistAnnotation, EffectiveChecklistJudgement } from "./annotations.js";
import { acquireOwnedFileLock, type OwnedFileLock } from "./lock.js";
import { assertRowMatchesRevision, recordChecklistRow } from "./mutations.js";
import { runDirPaths } from "./runDir.js";

/**
 * What a labeling session may do to a group of runs, and nothing more.
 *
 * The store exposes no file paths, no mutable rows and no unrestricted append:
 * those are how the sign-off ordering gets bypassed. It hands out read-only
 * projections and whole idempotent operations. Locks are its business:
 *
 * - one lock per session draft (`<group>/checklists/<id>/drafts/<session>.lock`),
 *   held until `close()`, so a second process cannot resume and mutate the
 *   same draft; other annotators and other checklists are not blocked;
 * - one short lock around each lineage publication
 *   (`<group>/checklists/<id>/.publish.lock`), so two sessions cannot race
 *   for the same revision number;
 * - the run's own writer lock around each append, taken by the mutation.
 *
 * There is no lock on the group as a whole.
 */
export class LabelStoreValidationError extends Error {}

export type OpenLabelStoreArgs = {
  group: LabelingGroup;
  identity: LabelSessionIdentity;
  reportWarning(message: string): void;
  /** @internal Test-only interruption points inside multi-file operations. */
  fault?: FaultHook;
};

/** One run as the screen shows it. */
export type LabelStoreItem = { runDir: string; traceId: string; fields: Fields };

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
  readSession(): LabelStoreSessionSnapshot;
  saveDraft(draft: Draft): void;
  prepareChecklist(definition: NormalizedDefinition): PrepareChecklistResult;
  syncChecklistDefinition(definitionPath: string, revision: ChecklistRevision): void;
  publishRevision(pending: PendingRevision, definitionPath: string): PublishRevisionResult;
  /** Append a completed checklist row exactly as given, to the run that holds
   *  its trace. Idempotent: a row whose id is already on disk is a replay. */
  appendAnnotation(row: ChecklistAnnotation): "appended" | "replayed";
  close(): void;
};

/**
 * Open a group for labeling, validating what labeling depends on before
 * returning: every checklist lineage in the group is contiguous and unedited,
 * and every existing checklist row in every run names a revision that exists
 * with the hash it recorded. Validation is fatal here where grading is
 * tolerant, because a label is the one artifact nothing can regenerate: a
 * checklist row that points at a missing revision would be labelled around
 * forever. The session lock is taken first and released if opening fails.
 */
export function openLabelStore(args: OpenLabelStoreArgs): LabelStore {
  const sessionLock = acquireOwnedFileLock({
    lockFile: sessionLockPath(args.group.dir, args.identity),
    reportWarning: args.reportWarning,
  });
  try {
    return createOpenStore(args, sessionLock);
  } catch (error) {
    sessionLock.release();
    throw error;
  }
}

function sessionLockPath(groupDir: string, identity: LabelSessionIdentity): string {
  return path.join(
    runDirPaths(groupDir).checklistsDir,
    identity.checklistId,
    "drafts",
    `${identity.sessionId}.lock`,
  );
}

function publicationLockPath(groupDir: string, checklistId: string): string {
  return path.join(runDirPaths(groupDir).checklistsDir, checklistId, ".publish.lock");
}

function createOpenStore(args: OpenLabelStoreArgs, sessionLock: OwnedFileLock): LabelStore {
  const { group, identity } = args;
  // The one mutable cache: each run's snapshot, replaced by the mutation's
  // authoritative post-write read after every append.
  const runs: LabelingRun[] = group.runs.map((run) => ({ ...run }));
  validateChecklists(group.dir, runs, args.reportWarning);

  let open = true;
  const assertOpen = (): void => {
    if (!open) {
      throw new LabelStoreValidationError("This label store has been closed");
    }
  };

  return {
    items(): readonly LabelStoreItem[] {
      assertOpen();
      return runs.map((run) => ({ runDir: run.dir, traceId: run.traceId, fields: run.fields }));
    },

    readSession(): LabelStoreSessionSnapshot {
      assertOpen();
      const key = `${identity.checklistId}:${identity.annotator.kind}:${identity.annotator.id}`;
      const judgements: Record<string, EffectiveChecklistJudgement> = Object.create(null);
      for (const run of runs) {
        const judgement = run.snapshot.effectiveAnnotations[run.traceId]?.checklists[key];
        if (judgement !== undefined) {
          judgements[run.traceId] = judgement;
        }
      }
      return {
        draft: loadDraftFile(group.dir, identity.checklistId, identity.sessionId) ?? null,
        judgements,
      };
    },

    saveDraft(draft: Draft): void {
      assertOpen();
      if (draft.sessionId !== identity.sessionId) {
        throw new LabelStoreValidationError(
          `This session (${identity.sessionId}) cannot write the draft of ${draft.sessionId}.`,
        );
      }
      saveDraftFile(group.dir, draft);
    },

    prepareChecklist(definition: NormalizedDefinition): PrepareChecklistResult {
      assertOpen();
      const pointer = readCurrentPointer(group.dir, definition.checklistId);
      const current =
        pointer === undefined
          ? undefined
          : readRevision(group.dir, definition.checklistId, pointer.version);
      return prepareRevision({ definition, current });
    },

    syncChecklistDefinition(definitionPath: string, revision: ChecklistRevision): void {
      assertOpen();
      syncChecklistDefinition({ definitionPath, revision });
    },

    publishRevision(pending: PendingRevision, definitionPath: string): PublishRevisionResult {
      assertOpen();
      // Publication re-reads the current pointer under the lock, so a pending
      // revision prepared against a parent that has since moved fails there
      // (`assertParentStillMatches`) without touching the lineage.
      const publication = acquireOwnedFileLock({
        lockFile: publicationLockPath(group.dir, pending.revision.checklistId),
        reportWarning: args.reportWarning,
      });
      try {
        return publishPendingRevision({
          dir: group.dir,
          pending,
          definitionPath,
          fault: args.fault,
        });
      } finally {
        publication.release();
      }
    },

    appendAnnotation(row: ChecklistAnnotation): "appended" | "replayed" {
      assertOpen();
      const run = runs.find((candidate) => candidate.traceId === row.traceId);
      if (run === undefined) {
        throw new LabelStoreValidationError(
          `Cannot record a judgement of trace "${row.traceId}": it is not in this session.`,
        );
      }
      const result = recordChecklistRow(
        { dir: run.dir, groupDir: group.dir, row },
        { reportWarning: args.reportWarning },
      );
      args.fault?.("after-annotation-append");
      run.snapshot = result.snapshot;
      return result.outcome;
    },

    close(): void {
      open = false;
      sessionLock.release();
    },
  };
}

// --- validation -----------------------------------------------------------

/** Every cross-file invariant labeling relies on, checked once at open:
 *  lineages in the group, and every run's checklist rows against them. */
function validateChecklists(
  groupDir: string,
  runs: readonly LabelingRun[],
  reportWarning: (message: string) => void,
): void {
  const revisionCache: Record<string, ChecklistRevision> = Object.create(null);
  const readCached = (checklistId: string, version: number): ChecklistRevision => {
    const key = `${checklistId}@${version}`;
    revisionCache[key] ??= readRevision(groupDir, checklistId, version);
    return revisionCache[key];
  };

  const checklistIds: string[] = [];
  for (const run of runs) {
    for (const row of run.snapshot.annotationRows) {
      if (row.kind === "checklist" && !checklistIds.includes(row.checklist)) {
        checklistIds.push(row.checklist);
      }
    }
  }
  const checklistsDir = runDirPaths(groupDir).checklistsDir;
  if (fs.existsSync(checklistsDir)) {
    for (const entry of fs.readdirSync(checklistsDir)) {
      if (!checklistIds.includes(entry)) {
        checklistIds.push(entry);
      }
    }
  }
  for (const checklistId of checklistIds) {
    validateLineage(groupDir, checklistId, readCached, reportWarning);
  }

  for (const run of runs) {
    for (const row of run.snapshot.annotationRows) {
      if (row.kind !== "checklist") {
        continue;
      }
      let revision: ChecklistRevision;
      try {
        revision = readCached(row.checklist, row.version);
      } catch (error) {
        throw new LabelStoreValidationError(
          `${run.dir}: annotation "${row.id}" refers to checklist revision ` +
            `${row.checklist}@${row.version}, which is missing from ${groupDir}: ` +
            `${(error as Error).message}`,
        );
      }
      try {
        assertRowMatchesRevision(row, revision);
      } catch (error) {
        throw new LabelStoreValidationError(`${run.dir}: ${(error as Error).message}`);
      }
    }
  }
}

function validateLineage(
  dir: string,
  checklistId: string,
  readCached: (checklistId: string, version: number) => ChecklistRevision,
  reportWarning: (message: string) => void,
): void {
  const versions = listRevisionVersions(dir, checklistId);
  if (versions.length === 0) {
    return;
  }
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
