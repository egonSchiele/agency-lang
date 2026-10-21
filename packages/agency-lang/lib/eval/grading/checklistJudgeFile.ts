import * as path from "path";

import { z } from "zod";

import { getAgentsDir } from "@/importPaths.js";

/** Bundled checklist judge: answers every point on a list with yes, no, or
 *  cannot tell, and quotes the words from the work that decided it. The
 *  rubric judge (`rubricJudgeFile.ts`) takes one standard and returns one
 *  number; this one returns an answer per point, so a failing point shows
 *  across runs without reading every verdict. */
export function checklistJudgeFile(): string {
  return path.join(getAgentsDir(), "eval", "checklistJudge.agency");
}

/** The bundled checklist judge's revision. Bump it whenever you edit
 *  `checklistJudge.agency`, and update the hash to match;
 *  `checklistJudgeFile.test.ts` fails when the file no longer hashes to it. */
export const CHECKLIST_JUDGE_VERSION = 1;
export const CHECKLIST_JUDGE_PROMPT_SHA256 =
  "e639c1b2c967065da7f7b486b505d5d87880718da895e28b9c614a50fddb3959";

/** The judge's structured verdict: one answer per point, in order, and a note.
 *  `pass` is null when the work does not say enough to tell. */
export const ChecklistVerdict = z.object({
  points: z.array(
    z.object({ name: z.string(), pass: z.boolean().nullable(), evidence: z.string() }),
  ),
  note: z.string(),
});
