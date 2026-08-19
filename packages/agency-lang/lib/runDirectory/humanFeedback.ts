import * as path from "path";

import { readCurrentPointer, readRevision } from "@/eval/label/checklist.js";
import type { ChecklistRevision } from "@/eval/label/types.js";

import type { RunDirectorySnapshot } from "./runDir.js";

/**
 * What people said about a trace, in words a consumer can feed back to the
 * model: the run's `notes.md`, if any, each checklist sign-off's note, and
 * the text of every checklist question with how it was answered. Grader feedback is separate (it rides on the score rows);
 * this is the human side. The optimizer feeds the model the `unchecked`
 * questions (what reviewers found wrong); `checked` is here for anything
 * that wants to say what a run did right, or to compare annotators.
 */
export type HumanFeedback = {
  notes: string[];
  /** Question texts answered `true` by any annotator on any checklist. */
  checked: string[];
  /** Question texts answered `false` by any annotator on any checklist. */
  unchecked: string[];
};

export function humanFeedbackFor(snapshot: RunDirectorySnapshot, traceId: string): HumanFeedback {
  const notes: string[] = [];
  if (snapshot.notes !== null && snapshot.notes.trim().length > 0) {
    notes.push(snapshot.notes.trim());
  }
  const effective = snapshot.effectiveAnnotations[traceId];
  if (effective === undefined) return { notes, checked: [], unchecked: [] };

  const checked: string[] = [];
  const unchecked: string[] = [];
  const revisions: Record<string, ChecklistRevision | null> = Object.create(null);
  for (const [key, judgement] of Object.entries(effective.checklists)) {
    const checklistId = key.slice(0, key.indexOf(":"));
    revisions[checklistId] ??= newestRevision(path.dirname(snapshot.dir), checklistId);
    const revision = revisions[checklistId];
    if (revision === null) continue;
    for (const question of revision.questions) {
      const answer = judgement.answers[question.id];
      if (answer === true && !checked.includes(question.text)) checked.push(question.text);
      if (answer === false && !unchecked.includes(question.text)) unchecked.push(question.text);
    }
    if (judgement.note.length > 0 && !notes.includes(judgement.note)) notes.push(judgement.note);
  }
  return { notes, checked, unchecked };
}

/** Question ids are allocated once and their text never changes, so the newest
 *  revision names every question any row could have answered. The lineage
 *  lives in the run's group (its parent directory); a run copied out of its
 *  group keeps its rows but yields no texts; a lineage that is present but
 *  broken throws, as it does everywhere. */
function newestRevision(dir: string, checklistId: string): ChecklistRevision | null {
  const pointer = readCurrentPointer(dir, checklistId);
  return pointer === undefined ? null : readRevision(dir, checklistId, pointer.version);
}
