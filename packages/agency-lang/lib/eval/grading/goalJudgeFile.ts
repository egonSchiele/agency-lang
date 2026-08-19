import * as path from "path";

import { z } from "zod";

import { getAgentsDir } from "@/importPaths.js";

/** Bundled scalar goal judge: scores how well an output satisfies the input's goal. */
export function goalJudgeFile(): string {
  return path.join(getAgentsDir(), "eval", "goalJudge.agency");
}

/** The bundled judge's revision, as written into score rows (`goal-judge@1`).
 *  Bump it whenever you edit `goalJudge.agency`, and update the hash below to
 *  match; `goalJudgeFile.test.ts` fails when the file no longer hashes to it,
 *  so a changed prompt cannot keep an old revision. */
export const GOAL_JUDGE_VERSION = 1;
export const GOAL_JUDGE_PROMPT_SHA256 =
  "3c3e426a4766a33edc02b8997fd4f18a5abe131ea4b463bc7a85ba38953e5bec";

/** Structured verdict shape the goal judge returns (0..1 score + reasoning). */
export const ScalarVerdict = z.object({ score: z.number(), reasoning: z.string() });

/** Render an agent output as the string a judge reads: strings pass through,
 *  everything else is JSON so it reads as data rather than "[object Object]".
 *  Top-level `undefined` (where JSON.stringify returns undefined) becomes "". */
export function asJudgeText(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output) ?? "";
}
