import * as path from "path";

import { openJsonlStrict, type OpenedJsonl } from "./jsonl.js";
import {
  AnnotationRowSchema,
  type AnnotationRow,
  type Annotator,
  type ChecklistQuestion,
  type ChecklistRevision,
} from "./types.js";

export function annotationsPath(datasetDir: string): string {
  return path.join(datasetDir, "labels.jsonl");
}

/** Private to the dataset: annotations may only be appended through the
 *  facade's transaction methods, which guarantee the corpus row exists first. */
export function openAnnotationLog(datasetDir: string): OpenedJsonl<AnnotationRow> {
  return openJsonlStrict({
    filePath: annotationsPath(datasetDir),
    schema: AnnotationRowSchema,
    identityOf: (row) => row.annotationId,
  });
}

/**
 * Who judged what.
 *
 * All four components are part of the key. Folding on kind alone would merge
 * every human; folding without the lineage would mix verdicts made against
 * unrelated checklists; and once machine judges write here, two judges with
 * different prompts must not be treated as one voice.
 */
export type AnnotationFoldKey = {
  outputId: string;
  checklistId: string;
  annotator: Annotator;
};

/** questionId → the answer that currently stands. */
export type EffectiveAnswers = Record<string, boolean>;

export type ItemStatus = "untouched" | "reviewed" | "stale";

export type ItemJudgement = {
  answers: EffectiveAnswers;
  revision: ChecklistRevision;
};

function matchesFoldKey(row: AnnotationRow, key: AnnotationFoldKey): boolean {
  return row.outputId === key.outputId &&
    row.checklistId === key.checklistId &&
    row.annotator.kind === key.annotator.kind &&
    row.annotator.id === key.annotator.id;
}

export function liveQuestions(revision: ChecklistRevision): ChecklistQuestion[] {
  return revision.questions.filter((question) => !question.deleted);
}

/**
 * Fold the annotation log per QUESTION, not per row.
 *
 * Taking the whole newest annotation would drop answers: judge a question,
 * soft-delete it, sign off again covering only the live questions, then
 * restore it — the deleted question's answer would vanish, breaking the
 * promise that undeleting restores prior work. Folding per question keeps it,
 * because the row that covered it is still in the append-only log.
 *
 * Append order decides, not `createdAt`. Timestamps tie at second resolution
 * and are not monotonic across a clock change; the order rows were written in
 * is what actually happened.
 */
export function effectiveAnswers(
  rows: readonly AnnotationRow[],
  key: AnnotationFoldKey,
): EffectiveAnswers {
  const answers: EffectiveAnswers = {};
  for (const row of rows) {
    if (!matchesFoldKey(row, key)) {
      continue;
    }
    for (const questionId of row.coveredQuestionIds) {
      const answer = row.answers[questionId];
      // Covered without an answer is a malformed row, rejected as a dataset
      // invariant. Treating it as `false` here would launder the corruption.
      if (typeof answer !== "boolean") {
        continue;
      }
      answers[questionId] = answer;
    }
  }
  return answers;
}

/** The most recent note this annotator left on this output, in append order. */
export function latestNote(rows: readonly AnnotationRow[], key: AnnotationFoldKey): string {
  let note = "";
  for (const row of rows) {
    if (matchesFoldKey(row, key)) {
      note = row.note;
    }
  }
  return note;
}

export function itemStatus(judgement: ItemJudgement): ItemStatus {
  if (Object.keys(judgement.answers).length === 0) {
    return "untouched";
  }
  const unjudged = liveQuestions(judgement.revision).some(
    (question) => judgement.answers[question.id] === undefined,
  );
  return unjudged ? "stale" : "reviewed";
}

/**
 * Weighted fraction of ticked boxes over live questions, or `null` when the
 * item is not fully judged.
 *
 * Treating an unjudged question as a failure would report a confident low
 * score for something nobody has finished looking at, which is worse than
 * reporting no score at all.
 */
export function score(judgement: ItemJudgement): number | null {
  const live = liveQuestions(judgement.revision);
  if (live.length === 0) {
    return null;
  }
  if (itemStatus(judgement) !== "reviewed") {
    return null;
  }
  const total = live.reduce((sum, question) => sum + question.weight, 0);
  const earned = live.reduce(
    (sum, question) => sum + (judgement.answers[question.id] === true ? question.weight : 0),
    0,
  );
  return earned / total;
}
