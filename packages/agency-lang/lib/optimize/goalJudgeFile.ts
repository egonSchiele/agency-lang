import * as path from "path";

import { z } from "zod";

import { getAgentsDir } from "@/importPaths.js";

/** Bundled scalar goal judge: scores how well an output satisfies the input's goal. */
export function goalJudgeFile(): string {
  return path.join(getAgentsDir(), "eval", "goalJudge.agency");
}

/** Structured verdict shape the goal judge returns (0..1 score + reasoning). */
export const ScalarVerdict = z.object({ score: z.number(), reasoning: z.string() });

/** Render an agent output as the string a judge reads: strings pass through,
 *  everything else is JSON so it reads as data rather than "[object Object]". */
export function asJudgeText(output: unknown): string {
  return typeof output === "string" ? output : globalThis.JSON.stringify(output);
}
