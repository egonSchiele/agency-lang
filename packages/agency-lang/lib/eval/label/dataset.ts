import * as fs from "fs";
import * as path from "path";

import { canonicalize } from "@/utils/canonicalize.js";

import { openAnnotationLog } from "./annotations.js";
import type { IngestSkip, LoadedBatch } from "./load/types.js";
import {
  listRevisionVersions,
  normalizeDefinition,
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
} from "./checklist.js";
import { openCorpusLog, type OpenedCorpusLog } from "./corpus.js";
import { loadDraftFile, saveDraftFile, type Draft } from "./draft.js";
import { makeOccurrenceId, makeOutputId } from "./ids.js";
import { atomicWriteValidated, type OpenedJsonl } from "./jsonl.js";
import { openOccurrenceLog, type OpenedOccurrenceLog } from "./occurrences.js";
import type { StoreLock } from "./lock.js";
import {
  ManifestSchema,
  type AnnotationRow,
  type ChecklistRevision,
  type CorpusRow,
  type DeepReadonly,
  type FaultHook,
  type LabelDatasetFaultPoint,
  type Manifest,
  type OccurrenceRow,
} from "./types.js";

export type { LabelDatasetFaultPoint };

export class DatasetValidationError extends Error {}

/** A store this build does not understand. Separate from DatasetValidationError
 *  so the CLI can tell "wrong format" from "corrupt". */
export class DatasetVersionError extends Error {}

export const CURRENT_DATASET_VERSION = 2;

export type OpenDatasetArgs = {
  storeDir: string;
  lock: StoreLock;
  reportWarning(message: string): void;
  /** @internal Test-only interruption points inside multi-file operations. */
  fault?: FaultHook;
};

export type IngestResult = {
  recordsAdded: number;
  recordsReplayed: number;
  occurrencesAdded: number;
  occurrencesReplayed: number;
  skips: readonly IngestSkip[];
  /** Field names this batch introduced that the store had never seen. The CLI
   *  warns about them: two batches using `output` and `response` produce
   *  disjoint record shapes that no question can span. */
  newFieldNames: readonly string[];
};

/**
 * Everything the controller may do to the store, and nothing more.
 *
 * The facade deliberately exposes no file paths, no mutable rows, no JSONL
 * handles and no unrestricted append: those are how the ordering guarantees
 * get bypassed. Callers get read-only projections and whole idempotent
 * operations.
 */
/** What one session needs to reconstruct itself: the completed history, an
 *  O(1) replay index, and its own in-progress draft if there is one. */
export type LabelDatasetSnapshot = {
  draft: DeepReadonly<Draft> | null;
  annotations: readonly DeepReadonly<AnnotationRow>[];
  annotationIds: Readonly<Record<string, true>>;
};

export type LabelDataset = {
  ingest(batch: LoadedBatch): IngestResult;
  readSession(sessionId: string): DeepReadonly<LabelDatasetSnapshot>;
  saveDraft(draft: Draft): void;
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
export function openDataset(args: OpenDatasetArgs): LabelDataset {
  fs.mkdirSync(args.storeDir, { recursive: true });
  assertDatasetVersion(args.storeDir);
  let manifest = ensureManifest(args.storeDir);

  const corpus = openCorpusLog(args.storeDir);
  const occurrences = openOccurrenceLog(args.storeDir);
  const annotations = openAnnotationLog(args.storeDir);
  validateDataset(args.storeDir, corpus, occurrences, annotations, manifest, args.reportWarning);

  // Built once, then kept current by captureSource, so grounding an annotation
  // is O(1) rather than a scan of the whole corpus per append.
  const knownOutputIds: Record<string, true> = Object.create(null);
  for (const row of corpus.rows() as readonly CorpusRow[]) {
    knownOutputIds[row.outputId] = true;
  }

  let open = true;
  const assertOpen = (): void => {
    if (!open) {
      throw new DatasetValidationError("This label store has been closed");
    }
  };

  return {
    ingest(batch: LoadedBatch): IngestResult {
      assertOpen();
      let recordsAdded = 0;
      let recordsReplayed = 0;
      let occurrencesAdded = 0;
      let occurrencesReplayed = 0;

      // Write order is load-bearing. A record first, its occurrence second: an
      // occurrence pointing at a record nobody stored is unrecoverable, while a
      // record with no occurrence is merely missing provenance and gets it back
      // by re-ingesting the same source.
      for (const candidate of batch.occurrences) {
        const record = corpus.ensureRecord(candidate.fields);
        if (record.added) {
          recordsAdded += 1;
        } else {
          recordsReplayed += 1;
        }
        knownOutputIds[record.row.outputId] = true;
        args.fault?.("after-record-append");

        const occurrence = occurrences.ensureOccurrence({
          outputId: record.row.outputId,
          source: candidate.source,
          origin: candidate.origin,
        });
        if (occurrence.added) {
          occurrencesAdded += 1;
        } else {
          occurrencesReplayed += 1;
        }
      }
      args.fault?.("after-occurrence-append");

      // Derived here, from the candidates actually accepted, rather than
      // carried alongside them. A loader maintaining a second copy of a fact
      // its own output already states is a copy that can drift.
      const seen: string[] = [];
      for (const candidate of batch.occurrences) {
        for (const name of Object.keys(candidate.fields)) {
          if (!seen.includes(name)) {
            seen.push(name);
          }
        }
      }
      // The manifest is last for the same reason records precede occurrences: a
      // stale fieldOrder only affects display, and re-ingesting repairs it.
      const newFieldNames = seen.filter((name) => !manifest.fieldOrder.includes(name));
      if (newFieldNames.length > 0) {
        manifest = { ...manifest, fieldOrder: [...manifest.fieldOrder, ...newFieldNames] };
        atomicWriteValidated({
          targetPath: manifestPath(args.storeDir),
          value: manifest,
          schema: ManifestSchema,
        });
      }

      return {
        recordsAdded,
        recordsReplayed,
        occurrencesAdded,
        occurrencesReplayed,
        skips: batch.skips,
        newFieldNames,
      };
    },

    readSession(sessionId: string): DeepReadonly<LabelDatasetSnapshot> {
      assertOpen();
      const rows = annotations.rows();
      const annotationIds: Record<string, true> = {};
      for (const row of rows as readonly AnnotationRow[]) {
        annotationIds[row.annotationId] = true;
      }
      return Object.freeze({
        draft: loadDraftFile(args.storeDir, sessionId) ?? null,
        annotations: rows,
        annotationIds: Object.freeze(annotationIds),
      });
    },

    saveDraft(draft: Draft): void {
      assertOpen();
      saveDraftFile(args.storeDir, draft);
    },

    corpusSnapshot(): readonly DeepReadonly<CorpusRow>[] {
      assertOpen();
      return corpus.rows();
    },

    checklistSnapshot(checklistId: string, version?: number): DeepReadonly<ChecklistRevision> {
      assertOpen();
      const resolved = version ?? readCurrentPointer(args.storeDir, checklistId)?.version;
      if (resolved === undefined) {
        throw new DatasetValidationError(`Checklist "${checklistId}" has no published revision`);
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
      assertAnnotationIsGrounded(args.storeDir, knownOutputIds, row);
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

/**
 * Reject an older store BEFORE opening any log.
 *
 * Order matters: parsing a version 1 log against a version 2 schema produces a
 * validation error deep inside a file, which reads as corruption rather than as
 * "this store predates the current format".
 */
function assertDatasetVersion(storeDir: string): void {
  const file = manifestPath(storeDir);
  if (!fs.existsSync(file)) {
    return;
  }
  let parsed: { schemaVersion?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { schemaVersion?: unknown };
  } catch (error) {
    throw new DatasetValidationError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const found = parsed.schemaVersion;
  if (found === CURRENT_DATASET_VERSION) {
    return;
  }
  // Rebuilding cannot help with a store from the FUTURE, so the two cases need
  // different advice.
  if (typeof found === "number" && found > CURRENT_DATASET_VERSION) {
    throw new DatasetVersionError(
      `${storeDir} uses label store format ${found}, which is newer than this build ` +
      `understands (${CURRENT_DATASET_VERSION}). Upgrade Agency to read it.`,
    );
  }
  // No migration exists, deliberately. Version 1 identified an output by the
  // run that produced it, so every id would change; and a label store is
  // derived data — the eval runs it came from are still on disk, so re-ingesting
  // rebuilds it. Refusing to open one is the part that matters: silently
  // misreading an old file is the only outcome worth preventing.
  throw new DatasetVersionError(
    `${storeDir} uses label store format ${String(found)}; this build writes ` +
    `format ${CURRENT_DATASET_VERSION}. That store predates content-derived record ids, so its ` +
    `labels cannot be carried across.\n\n` +
    `  Delete ${storeDir} and rebuild it with \`agency label ingest\`.\n`,
  );
}

/** The display order a renderer needs, without opening the whole store. Absent
 *  or unreadable is an empty order, not an error: this only affects layout. */
export function readFieldOrder(storeDir: string): readonly string[] {
  const file = manifestPath(storeDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  const parsed = ManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  return parsed.success ? parsed.data.fieldOrder : [];
}

function ensureManifest(storeDir: string): Manifest {
  const file = manifestPath(storeDir);
  if (!fs.existsSync(file)) {
    const fresh: Manifest = { schemaVersion: CURRENT_DATASET_VERSION, fieldOrder: [] };
    atomicWriteValidated({ targetPath: file, value: fresh, schema: ManifestSchema });
    return fresh;
  }
  const parsed = ManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new DatasetValidationError(
      `${file} is not a label store manifest this build understands. Refusing to touch the ` +
      `store rather than risk a dataset written by a different version.`,
    );
  }
  return parsed.data;
}

/** Every cross-file invariant, checked once at open. */
function validateDataset(
  storeDir: string,
  corpus: OpenedCorpusLog,
  occurrences: OpenedOccurrenceLog,
  annotations: OpenedJsonl<AnnotationRow>,
  manifest: Manifest,
  reportWarning: (message: string) => void,
): void {
  const corpusById: Record<string, CorpusRow> = Object.create(null);
  for (const row of corpus.rows()) {
    // Shape-only validation is not enough for a derived identity: a hand-edited
    // row could hold a well-formed id that is not the hash of its own fields,
    // and every label on it would then describe text nobody can reconstruct.
    const expected = makeOutputId(row.fields);
    if (row.outputId !== expected) {
      throw new DatasetValidationError(
        `Corpus row "${row.outputId}" does not match the hash of its own fields (${expected}). ` +
        `An output id is derived from its content and cannot be edited independently.`,
      );
    }
    corpusById[row.outputId] = row;
  }

  for (const row of occurrences.rows()) {
    const expected = makeOccurrenceId({
      outputId: row.outputId,
      source: row.source,
      origin: row.origin,
    });
    if (row.occurrenceId !== expected) {
      throw new DatasetValidationError(
        `Occurrence "${row.occurrenceId}" does not match the hash of its own identity ` +
        `(${expected}).`,
      );
    }
    if (corpusById[row.outputId] === undefined) {
      throw new DatasetValidationError(
        `Occurrence "${row.occurrenceId}" refers to output "${row.outputId}", which is not in ` +
        `the corpus. Records are always written before the occurrences that reference them.`,
      );
    }
  }

  const seenFieldNames: Record<string, true> = Object.create(null);
  for (const name of manifest.fieldOrder) {
    if (seenFieldNames[name] === true) {
      throw new DatasetValidationError(
        `The manifest lists field "${name}" more than once in fieldOrder.`,
      );
    }
    seenFieldNames[name] = true;
  }

  const revisionCache: Record<string, ChecklistRevision> = Object.create(null);
  const readCached = (checklistId: string, version: number): ChecklistRevision => {
    const key = `${checklistId}@${version}`;
    if (revisionCache[key] === undefined) {
      revisionCache[key] = readRevision(storeDir, checklistId, version);
    }
    return revisionCache[key];
  };

  validateLineages(storeDir, annotations, readCached, reportWarning);

  for (const row of annotations.rows() as readonly AnnotationRow[]) {
    if (corpusById[row.outputId] === undefined) {
      throw new DatasetValidationError(
        `Annotation "${row.annotationId}" refers to output "${row.outputId}", which is not in ` +
        `the corpus. Outputs are always captured before they can be labelled.`,
      );
    }
    let revision: ChecklistRevision;
    try {
      revision = readCached(row.checklistId, row.checklistVersion);
    } catch (error) {
      throw new DatasetValidationError(
        `Annotation "${row.annotationId}" refers to checklist revision ` +
        `${row.checklistId}@${row.checklistVersion}, which is missing: ${(error as Error).message}`,
      );
    }
    if (revision.hash !== row.checklistHash) {
      throw new DatasetValidationError(
        `Annotation "${row.annotationId}" records checklist hash ${row.checklistHash}, but ` +
        `revision ${row.checklistId}@${row.checklistVersion} hashes to ${revision.hash}.`,
      );
    }
    assertAnswersCoverExactly(row, revision);
  }
}

function validateLineages(
  storeDir: string,
  annotations: OpenedJsonl<AnnotationRow>,
  readCached: (checklistId: string, version: number) => ChecklistRevision,
  reportWarning: (message: string) => void,
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
    // readRevision proves path/content agreement and recomputes the hash;
    // validateLineageContinuity proves the chain is contiguous and that every
    // adjacent pair obeys the same evolution rules publication enforces.
    try {
      validateLineageContinuity(storeDir, checklistId, versions);
    } catch (error) {
      throw new DatasetValidationError((error as Error).message);
    }
    const pointer = readCurrentPointer(storeDir, checklistId);
    if (pointer === undefined) {
      throw new DatasetValidationError(
        `Checklist "${checklistId}" has ${versions.length} revision(s) but no current pointer.`,
      );
    }
    const newest = versions[versions.length - 1];
    if (pointer.version > newest) {
      throw new DatasetValidationError(
        `Checklist "${checklistId}" current points at version ${pointer.version}, which has no ` +
        `stored revision. The newest is ${newest}.`,
      );
    }
    if (pointer.hash !== readCached(checklistId, pointer.version).hash) {
      throw new DatasetValidationError(
        `Checklist "${checklistId}" current records hash ${pointer.hash}, which does not match ` +
        `revision ${pointer.version}.`,
      );
    }
    // A pointer that LAGS is recoverable, not corrupt: it is exactly what a
    // crash between the immutable rename and the pointer update leaves behind,
    // and the revisions past it are complete and immutable. Refusing to open
    // here would make that state permanently unrepairable, since recovery runs
    // after the store opens. Report it and let the session advance the pointer.
    if (pointer.version < newest) {
      reportWarning(
        `Checklist "${checklistId}" has revisions up to ${newest} but current points at ` +
        `${pointer.version}, which means a publication was interrupted. Reopening a session on ` +
        `this checklist completes it.`,
      );
    }
  }
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
      throw new DatasetValidationError(
        `Annotation "${row.annotationId}" covers question "${questionId}", which revision ` +
        `${row.checklistId}@${row.checklistVersion} does not define.`,
      );
    }
    if (typeof row.answers[questionId] !== "boolean") {
      throw new DatasetValidationError(
        `Annotation "${row.annotationId}" covers question "${questionId}" but records no answer. ` +
        `A covered question carries an explicit true or false; a missing answer means "not judged" ` +
        `and must not be listed as covered.`,
      );
    }
  }
  const covered = new Set(row.coveredQuestionIds);
  for (const questionId of Object.keys(row.answers)) {
    if (!covered.has(questionId)) {
      throw new DatasetValidationError(
        `Annotation "${row.annotationId}" answers question "${questionId}" without covering it.`,
      );
    }
  }
}

/** Refuse an annotation whose output is not already in the corpus, so the
 *  capture-before-label ordering cannot be skipped by any caller.
 *
 *  `knownOutputIds` is maintained by the caller rather than rebuilt here: a
 *  linear scan per append would make grounding O(annotations × corpus rows)
 *  over a session, when the log is already indexed by identity. */
function assertAnnotationIsGrounded(
  storeDir: string,
  knownOutputIds: Record<string, true>,
  row: AnnotationRow,
): void {
  const present = knownOutputIds[row.outputId] === true;
  if (!present) {
    throw new DatasetValidationError(
      `Cannot record a judgement of output "${row.outputId}": it is not in the corpus. ` +
      `Capture the source before labelling it.`,
    );
  }
  const revision = readRevision(storeDir, row.checklistId, row.checklistVersion);
  if (revision.hash !== row.checklistHash) {
    throw new DatasetValidationError(
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
