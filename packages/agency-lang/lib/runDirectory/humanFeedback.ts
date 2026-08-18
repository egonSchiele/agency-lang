import { readCurrentPointer, readRevision } from "@/eval/label/checklist.js";
import type { ChecklistRevision } from "@/eval/label/types.js";

import type { RunDirectorySnapshot } from "./runDir.js";

/**
 * What people said about a trace, in words an optimizer can feed back to the
 * model: every note, and the text of every checklist question someone answered
 * "no". Grader feedback is separate (it rides on the score rows); this is the
 * human side.
 */
export type HumanFeedback = {
  notes: string[];
  /** Question texts answered `false` by any annotator on any checklist. */
  unchecked: string[];
};

export function humanFeedbackFor(snapshot: RunDirectorySnapshot, traceId: string): HumanFeedback {
  const effective = snapshot.effectiveAnnotations[traceId];
  if (effective === undefined) return { notes: [], unchecked: [] };
  const notes = effective.notes.flatMap((row) => (row.kind === "note" ? [row.text] : []));

  const unchecked: string[] = [];
  const revisions: Record<string, ChecklistRevision | null> = Object.create(null);
  for (const [key, judgement] of Object.entries(effective.checklists)) {
    const checklistId = key.slice(0, key.indexOf(":"));
    revisions[checklistId] ??= newestRevision(snapshot.dir, checklistId);
    const revision = revisions[checklistId];
    if (revision === null) continue;
    for (const question of revision.questions) {
      if (judgement.answers[question.id] === false && !unchecked.includes(question.text)) {
        unchecked.push(question.text);
      }
    }
    if (judgement.note.length > 0 && !notes.includes(judgement.note)) notes.push(judgement.note);
  }
  return { notes, unchecked };
}

/** Question ids are allocated once and their text never changes, so the newest
 *  revision names every question any row could have answered. A directory that
 *  carries checklist rows but no lineage (rows merged in from elsewhere) yields
 *  no texts; a lineage that is present but broken throws, as it does everywhere. */
function newestRevision(dir: string, checklistId: string): ChecklistRevision | null {
  const pointer = readCurrentPointer(dir, checklistId);
  return pointer === undefined ? null : readRevision(dir, checklistId, pointer.version);
}
