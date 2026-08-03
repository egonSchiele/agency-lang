import * as fs from "fs";
import * as path from "path";

import { canonicalize } from "@/utils/canonicalize.js";

import { openAnnotationLog } from "./annotations.js";
import {
  captureSourceOccurrences,
  type CaptureResult,
} from "./capture.js";
import {
  listRevisionVersions,
  normalizeDefinition,
  prepareRevision,
  publishPendingRevision,
  readCurrentPointer,
  readRevision,
  syncChecklistDefinition,
  type NormalizedDefinition,
  type PendingRevision,
  type PrepareChecklistResult,
  type PublishRevisionResult,
} from "./checklist.js";
import { openCorpusLog } from "./corpus.js";
import { atomicWriteValidated, type OpenedJsonl } from "./jsonl.js";
import type { StoreLock } from "./lock.js";
import {
  ManifestSchema,
  type AnnotationRow,
  type ChecklistRevision,
  type CorpusRow,
  type DeepReadonly,
  type FaultHook,
  type LabelStoreFaultPoint,
} from "./types.js";

export type { LabelStoreFaultPoint };

export class StoreValidationError extends Error {}

export type OpenStoreArgs = {
  storeDir: string;
  lock: StoreLock;
  reportWarning(message: string): void;
  /** @internal Test-only interruption points inside multi-file operations. */
  fault?: FaultHook;
};

export type CaptureSourceArgs = {
  sourceDir: string;
};

/**
 * Everything the controller may do to the store, and nothing more.
 *
 * The facade deliberately exposes no file paths, no mutable rows, no JSONL
 * handles and no unrestricted append: those are how the ordering guarantees
 * get bypassed. Callers get read-only projections and whole idempotent
 * operations.
 */
export type LabelStore = {
  captureSource(args: CaptureSourceArgs): CaptureResult;
  annotationSnapshot(): readonly DeepReadonly<AnnotationRow>[];
  corpusSnapshot(): readonly DeepReadonly<CorpusRow>[];
  checklistSnapshot(checklistId: string, version?: number): DeepReadonly<ChecklistRevision>;
  prepareChecklist(definition: NormalizedDefinition): PrepareChecklistResult;
  syncChecklistDefinition(definitionPath: string, revision: ChecklistRevision): void;
  publishRevision(pending: PendingRevision, definitionPath: string): PublishRevisionResult;
  appendAnnotation(row: AnnotationRow): "appended" | "replayed";
  close(): void;
};

export function manifestPath(storeDir: string): string {
  return path.join(storeDir, "manifest.json");
}

/**
 * Open a store, validating everything in it before returning.
 *
 * Validation is total and fatal. `lib/eval/readRun.ts` degrades a bad file and
 * warns, because grading runs after every agent has been paid for and one
 * unreadable record must not waste the pass. This dataset is the opposite
 * case: it is the one artifact nothing can regenerate, so a broken reference
 * stops the session rather than being labelled around.
 */
export function openStore(args: OpenStoreArgs): LabelStore {
  fs.mkdirSync(args.storeDir, { recursive: true });
  ensureManifest(args.storeDir);

  const corpus = openCorpusLog(args.storeDir);
  const annotations = openAnnotationLog(args.storeDir);
  validateStore(args.storeDir, corpus, annotations);

  let open = true;
  const assertOpen = (): void => {
    if (!open) {
      throw new StoreValidationError("This label store has been closed");
    }
  };

  return {
    captureSource(captureArgs: CaptureSourceArgs): CaptureResult {
      assertOpen();
      return captureSourceOccurrences({
        sourceDir: captureArgs.sourceDir,
        corpus,
        reportWarning: args.reportWarning,
      });
    },

    annotationSnapshot(): readonly DeepReadonly<AnnotationRow>[] {
      assertOpen();
      return annotations.rows();
    },

    corpusSnapshot(): readonly DeepReadonly<CorpusRow>[] {
      assertOpen();
      return corpus.rows();
    },

    checklistSnapshot(checklistId: string, version?: number): DeepReadonly<ChecklistRevision> {
      assertOpen();
      const resolved = version ?? readCurrentPointer(args.storeDir, checklistId)?.version;
      if (resolved === undefined) {
        throw new StoreValidationError(`Checklist "${checklistId}" has no published revision`);
      }
      return readRevision(args.storeDir, checklistId, resolved);
    },

    prepareChecklist(definition: NormalizedDefinition): PrepareChecklistResult {
      assertOpen();
      const pointer = readCurrentPointer(args.storeDir, definition.checklistId);
      const current = pointer === undefined
        ? undefined
        : readRevision(args.storeDir, definition.checklistId, pointer.version);
      return prepareRevision({ definition, current });
    },

    syncChecklistDefinition(definitionPath: string, revision: ChecklistRevision): void {
      assertOpen();
      syncChecklistDefinition({ definitionPath, revision });
    },

    publishRevision(pending: PendingRevision, definitionPath: string): PublishRevisionResult {
      assertOpen();
      return publishPendingRevision({
        storeDir: args.storeDir, pending, definitionPath, fault: args.fault,
      });
    },

    appendAnnotation(row: AnnotationRow): "appended" | "replayed" {
      assertOpen();
      assertAnnotationIsGrounded(args.storeDir, corpus, row);
      const outcome = annotations.appendExact(row);
      args.fault?.("after-annotation-append");
      return outcome;
    },

    close(): void {
      open = false;
      args.lock.release();
    },
  };
}

function ensureManifest(storeDir: string): void {
  const file = manifestPath(storeDir);
  if (!fs.existsSync(file)) {
    atomicWriteValidated({ targetPath: file, value: { schemaVersion: 1 }, schema: ManifestSchema });
    return;
  }
  const parsed = ManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new StoreValidationError(
      `${file} is not a label store manifest this build understands. Refusing to touch the ` +
      `store rather than risk a dataset written by a different version.`,
    );
  }
}

/** Every cross-file invariant, checked once at open. */
function validateStore(
  storeDir: string,
  corpus: OpenedJsonl<CorpusRow>,
  annotations: OpenedJsonl<AnnotationRow>,
): void {
  const corpusById: Record<string, CorpusRow> = Object.create(null);
  for (const row of corpus.rows() as readonly CorpusRow[]) {
    corpusById[row.outputId] = row;
  }

  const revisionCache: Record<string, ChecklistRevision> = Object.create(null);
  const readCached = (checklistId: string, version: number): ChecklistRevision => {
    const key = `${checklistId}@${version}`;
    if (revisionCache[key] === undefined) {
      revisionCache[key] = readRevision(storeDir, checklistId, version);
    }
    return revisionCache[key];
  };

  validateLineages(storeDir, corpus, annotations, readCached);

  for (const row of annotations.rows() as readonly AnnotationRow[]) {
    if (corpusById[row.outputId] === undefined) {
      throw new StoreValidationError(
        `Annotation "${row.annotationId}" refers to output "${row.outputId}", which is not in ` +
        `the corpus. Outputs are always captured before they can be labelled.`,
      );
    }
    let revision: ChecklistRevision;
    try {
      revision = readCached(row.checklistId, row.checklistVersion);
    } catch (error) {
      throw new StoreValidationError(
        `Annotation "${row.annotationId}" refers to checklist revision ` +
        `${row.checklistId}@${row.checklistVersion}, which is missing: ${(error as Error).message}`,
      );
    }
    if (revision.hash !== row.checklistHash) {
      throw new StoreValidationError(
        `Annotation "${row.annotationId}" records checklist hash ${row.checklistHash}, but ` +
        `revision ${row.checklistId}@${row.checklistVersion} hashes to ${revision.hash}.`,
      );
    }
    assertAnswersCoverExactly(row, revision);
  }
}

function validateLineages(
  storeDir: string,
  corpus: OpenedJsonl<CorpusRow>,
  annotations: OpenedJsonl<AnnotationRow>,
  readCached: (checklistId: string, version: number) => ChecklistRevision,
): void {
  const checklistIds = new Set<string>();
  for (const row of annotations.rows() as readonly AnnotationRow[]) {
    checklistIds.add(row.checklistId);
  }
  const checklistsDir = path.join(storeDir, "checklists");
  if (fs.existsSync(checklistsDir)) {
    for (const entry of fs.readdirSync(checklistsDir)) {
      checklistIds.add(entry);
    }
  }

  for (const checklistId of checklistIds) {
    const versions = listRevisionVersions(storeDir, checklistId);
    if (versions.length === 0) {
      continue;
    }
    let previous: ChecklistRevision | undefined;
    for (const version of versions) {
      const revision = readCached(checklistId, version);
      if (revision.checklistId !== checklistId) {
        throw new StoreValidationError(
          `Revision ${checklistId}@${version} records lineage "${revision.checklistId}"; ` +
          `it is stored under "${checklistId}".`,
        );
      }
      const expectedParent = previous === undefined ? null : previous.version;
      if (revision.parentVersion !== expectedParent) {
        throw new StoreValidationError(
          `Revision ${checklistId}@${version} records parent ${revision.parentVersion}, ` +
          `but the previous published revision is ${expectedParent}.`,
        );
      }
      previous = revision;
    }
    const pointer = readCurrentPointer(storeDir, checklistId);
    if (pointer === undefined) {
      throw new StoreValidationError(
        `Checklist "${checklistId}" has ${versions.length} revision(s) but no current pointer.`,
      );
    }
    const newest = versions[versions.length - 1];
    if (pointer.version !== newest) {
      throw new StoreValidationError(
        `Checklist "${checklistId}" current points at version ${pointer.version}, but the ` +
        `newest published revision is ${newest}. A crash between the two is repaired by ` +
        `reopening a session on this checklist.`,
      );
    }
    if (pointer.hash !== readCached(checklistId, pointer.version).hash) {
      throw new StoreValidationError(
        `Checklist "${checklistId}" current records hash ${pointer.hash}, which does not match ` +
        `revision ${pointer.version}.`,
      );
    }
  }
  void corpus;
}

/**
 * A covered question must carry an explicit boolean, and an answer may not
 * appear for a question that was not covered. "Covered" is the claim that a
 * person looked; without exact correspondence the per-question fold would be
 * reading answers nobody gave.
 */
function assertAnswersCoverExactly(row: AnnotationRow, revision: ChecklistRevision): void {
  const known: Record<string, true> = Object.create(null);
  for (const question of revision.questions) {
    known[question.id] = true;
  }
  for (const questionId of row.coveredQuestionIds) {
    if (known[questionId] !== true) {
      throw new StoreValidationError(
        `Annotation "${row.annotationId}" covers question "${questionId}", which revision ` +
        `${row.checklistId}@${row.checklistVersion} does not define.`,
      );
    }
    if (typeof row.answers[questionId] !== "boolean") {
      throw new StoreValidationError(
        `Annotation "${row.annotationId}" covers question "${questionId}" but records no answer. ` +
        `A covered question carries an explicit true or false; a missing answer means "not judged" ` +
        `and must not be listed as covered.`,
      );
    }
  }
  const covered = new Set(row.coveredQuestionIds);
  for (const questionId of Object.keys(row.answers)) {
    if (!covered.has(questionId)) {
      throw new StoreValidationError(
        `Annotation "${row.annotationId}" answers question "${questionId}" without covering it.`,
      );
    }
  }
}

/** Refuse an annotation whose output is not already in the corpus, so the
 *  capture-before-label ordering cannot be skipped by any caller. */
function assertAnnotationIsGrounded(
  storeDir: string,
  corpus: OpenedJsonl<CorpusRow>,
  row: AnnotationRow,
): void {
  const present = (corpus.rows() as readonly CorpusRow[]).some(
    (existing) => existing.outputId === row.outputId,
  );
  if (!present) {
    throw new StoreValidationError(
      `Cannot record a judgement of output "${row.outputId}": it is not in the corpus. ` +
      `Capture the source before labelling it.`,
    );
  }
  const revision = readRevision(storeDir, row.checklistId, row.checklistVersion);
  if (revision.hash !== row.checklistHash) {
    throw new StoreValidationError(
      `Annotation "${row.annotationId}" records checklist hash ${row.checklistHash}, but ` +
      `revision ${row.checklistId}@${row.checklistVersion} hashes to ${revision.hash}.`,
    );
  }
  assertAnswersCoverExactly(row, revision);
}

/** Re-exported so callers do not need a second import for the common path of
 *  turning a raw definition into one the store accepts. */
export { normalizeDefinition };

/** Canonical form of a stored revision, for tests and diagnostics. */
export function revisionFingerprint(revision: ChecklistRevision): string {
  return canonicalize(revision);
}
