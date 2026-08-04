import { effectiveAnswers, latestNote } from "../annotations.js";
import { makeOccurrenceId, makeOutputId } from "../ids.js";
import { projectArtifactField } from "../project.js";
import {
  CorpusRowSchema,
  OccurrenceRowSchema,
  type AnnotationRow,
  type Annotator,
  type CorpusRow,
  type Fields,
  type OccurrenceRow,
} from "../types.js";

import type { V1CorpusRow, V1StoreSnapshot } from "./readV1.js";

/** The source name given to every migrated observation. Version 1 rows have no
 *  source, and inventing one from a directory basename would be a guess
 *  presented as a fact. */
export const LEGACY_SOURCE = "legacy";

export class MigrationConflictError extends Error {}
export class MigrationBlockedError extends Error {}

export type MigrationCounts = {
  oldRecords: number;
  newRecords: number;
  mergedGroups: number;
  occurrences: number;
  annotations: number;
};

export type MigrationPlan = {
  records: readonly CorpusRow[];
  occurrences: readonly OccurrenceRow[];
  annotations: readonly AnnotationRow[];
  fieldOrder: readonly string[];
  counts: MigrationCounts;
};

/**
 * The fields a version 1 row becomes.
 *
 * `output` comes from the persisted `text`, NOT from re-projecting `value`.
 * Version 1 stored `text` precisely so the labelled artifact stays exactly what
 * the annotator saw, and its session displayed that field. Recomputing it here
 * would move annotations onto different bytes whenever the projection rule has
 * changed since — and still produce a store that validates. `value` survives as
 * occurrence provenance.
 *
 * `task` has no such witness: version 1 never persisted a rendering of it, so
 * projecting is the only option.
 */
export function fieldsOfV1Row(row: V1CorpusRow): Fields {
  return {
    task: projectArtifactField(row.input.task),
    output: row.text,
  };
}

type Group = {
  outputId: string;
  fields: Fields;
  rows: V1CorpusRow[];
};

function groupByNewIdentity(corpus: readonly V1CorpusRow[]): Group[] {
  const byId: Record<string, Group> = Object.create(null);
  const order: string[] = [];
  for (const row of corpus) {
    const fields = fieldsOfV1Row(row);
    const outputId = makeOutputId(fields);
    if (byId[outputId] === undefined) {
      byId[outputId] = { outputId, fields, rows: [] };
      order.push(outputId);
    }
    byId[outputId].rows.push(row);
  }
  return order.map((outputId) => byId[outputId]);
}

function annotatorKey(annotator: Annotator): string {
  return `${annotator.kind}\0${annotator.id}`;
}

/**
 * Refuse to merge two records that were judged differently.
 *
 * Content identity deliberately merges equal field maps, so two version 1 rows
 * can become one version 2 record. If the same annotator answered the same
 * question differently on each, rewriting both onto the merged id would turn
 * two independent judgements into one relabel history — and because answers
 * fold in APPEND order, whichever row happened to be processed second would
 * win. That would make migration order decide the dataset, so this refuses
 * instead.
 *
 * The comparison is done under each OLD output id. Asking for the effective
 * answers of the new id before anything has been rewritten returns nothing at
 * all, and every conflict would pass unnoticed.
 */
function assertNoConflicts(group: Group, annotations: readonly AnnotationRow[]): void {
  if (group.rows.length < 2) {
    return;
  }
  const oldIds = group.rows.map((row) => row.outputId);

  // Every (checklist, annotator) pair that judged any row in this group.
  const pairs: Record<string, { checklistId: string; annotator: Annotator }> = Object.create(null);
  for (const row of annotations) {
    if (!oldIds.includes(row.outputId)) {
      continue;
    }
    pairs[`${row.checklistId}\0${annotatorKey(row.annotator)}`] = {
      checklistId: row.checklistId,
      annotator: row.annotator,
    };
  }

  for (const pairKey of Object.keys(pairs)) {
    const { checklistId, annotator } = pairs[pairKey];
    // "No annotation at all" and "an annotation whose effective state is empty"
    // are different things. Dropping the second lets a later note-only row with
    // an empty note clear an earlier note after the merge, which is exactly the
    // order-dependence this guard exists to prevent.
    const states = oldIds
      .filter((outputId) => annotations.some((row) =>
        row.outputId === outputId &&
        row.checklistId === checklistId &&
        row.annotator.kind === annotator.kind &&
        row.annotator.id === annotator.id))
      .map((outputId) => ({
        outputId,
        answers: effectiveAnswers(annotations, { outputId, checklistId, annotator }),
        note: latestNote(annotations, { outputId, checklistId, annotator }),
      }));

    if (states.length < 2) {
      continue;
    }

    const [first, ...rest] = states;
    for (const other of rest) {
      const differing = Object.keys({ ...first.answers, ...other.answers })
        .filter((questionId) => first.answers[questionId] !== other.answers[questionId]);
      const noteDiffers = first.note !== other.note;
      if (differing.length === 0 && !noteDiffers) {
        continue;
      }
      throw new MigrationConflictError(
        `Cannot migrate: outputs ${first.outputId} and ${other.outputId} hold identical text, ` +
        `so they become one record, but ${annotator.id} judged them differently under ` +
        `${checklistId}.\n` +
        (differing.length > 0 ? `  conflicting questions: ${differing.join(", ")}\n` : "") +
        (noteDiffers ? "  their notes also differ\n" : "") +
        "  Decide which judgement stands, remove the other from labels.jsonl, and migrate again.",
      );
    }
  }
}

/**
 * Turn a version 1 snapshot into everything a version 2 store needs.
 *
 * Pure: no directory is created and nothing is written, so a conflict is found
 * before any file exists to clean up.
 */
export function planMigration(source: V1StoreSnapshot): MigrationPlan {
  if (source.draftFiles.length > 0) {
    throw new MigrationBlockedError(
      `${source.storeDir} has ${source.draftFiles.length} in-progress labelling session` +
      `${source.draftFiles.length === 1 ? "" : "s"}. A draft is bound to an ordered list of ` +
      "output ids that migration invalidates. Finish or discard the session first, then " +
      "migrate.",
    );
  }

  const groups = groupByNewIdentity(source.corpus);
  const records: CorpusRow[] = [];
  const occurrences: OccurrenceRow[] = [];
  const idMap: Record<string, string> = Object.create(null);

  for (const group of groups) {
    assertNoConflicts(group, source.annotations);

    // Earliest capture in the group, so a merged record's timestamp does not
    // depend on the order rows happened to be read in.
    const capturedAt = group.rows
      .map((row) => row.capturedAt)
      .reduce((earliest, candidate) => (candidate < earliest ? candidate : earliest));

    records.push(CorpusRowSchema.parse({
      schemaVersion: 2,
      outputId: group.outputId,
      capturedAt,
      fields: group.fields,
    }));

    // One occurrence per OLD row, so merging two records never loses the fact
    // that two executions produced this text.
    for (const row of group.rows) {
      idMap[row.outputId] = group.outputId;
      const origin = {
        kind: "legacy" as const,
        traceId: row.execution.traceId,
        inputId: row.execution.inputId,
        finalOutputIndex: row.execution.finalOutputIndex,
        runStartedAtMs: row.provenance.runStartedAtMs,
        models: row.provenance.models,
        agent: row.provenance.agent,
        rawTask: row.input.task,
        rawValue: row.value,
      };
      occurrences.push(OccurrenceRowSchema.parse({
        schemaVersion: 1,
        occurrenceId: makeOccurrenceId({
          outputId: group.outputId,
          source: LEGACY_SOURCE,
          origin,
        }),
        outputId: group.outputId,
        source: LEGACY_SOURCE,
        firstObservedAt: row.capturedAt,
        origin,
      }));
    }
  }

  // Rewritten in their original order. Synthesizing one replacement annotation
  // per record would be smaller and would discard history, timing and the
  // sequence of note edits.
  const annotations = source.annotations.map((row) => {
    const outputId = idMap[row.outputId];
    if (outputId === undefined) {
      throw new MigrationBlockedError(
        `Annotation "${row.annotationId}" refers to output "${row.outputId}", which is not in ` +
        "the corpus. The source store is inconsistent; migration cannot guess what it judged.",
      );
    }
    return { ...row, outputId };
  });

  return {
    records,
    occurrences,
    annotations,
    fieldOrder: ["task", "output"],
    counts: {
      oldRecords: source.corpus.length,
      newRecords: records.length,
      mergedGroups: groups.filter((group) => group.rows.length > 1).length,
      occurrences: occurrences.length,
      annotations: annotations.length,
    },
  };
}
