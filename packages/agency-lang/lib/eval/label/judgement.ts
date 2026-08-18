import type { ChecklistQuestion, ChecklistRevision } from "./types.js";

/**
 * What one annotator's folded answers say about one trace. The fold itself
 * (per question, in append order, keyed by checklist and annotator) is the run
 * directory's `foldAnnotations`; this module only turns its result into a
 * status and a score.
 */

/** questionId → the answer that currently stands. */
export type EffectiveAnswers = Record<string, boolean>;

export type ItemStatus = "untouched" | "reviewed" | "stale";

export type ItemJudgement = {
  answers: EffectiveAnswers;
  revision: ChecklistRevision;
};

export function liveQuestions(revision: ChecklistRevision): ChecklistQuestion[] {
  return revision.questions.filter((question) => !question.deleted);
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
