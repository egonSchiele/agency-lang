import * as path from "path";

import { getAgentsDir } from "@/importPaths.js";

/** Bundled rubric judge: scores how well an output meets a stated standard,
 *  with reference material as context rather than an answer key. The goal
 *  judge (`goalJudgeFile.ts`) is the other frame: did the output answer the
 *  goal correctly. Rubric judging is for "do these findings meet this bar". */
export function rubricJudgeFile(): string {
  return path.join(getAgentsDir(), "eval", "rubricJudge.agency");
}

/** The bundled rubric judge's revision. Bump it whenever you edit
 *  `rubricJudge.agency`, and update the hash to match; `rubricJudgeFile.test.ts`
 *  fails when the file no longer hashes to it. */
export const RUBRIC_JUDGE_VERSION = 1;
export const RUBRIC_JUDGE_PROMPT_SHA256 =
  "be940a0c0a1dca039156aa2123c263167167a39edff76e4ff467e682b75df2e5";
