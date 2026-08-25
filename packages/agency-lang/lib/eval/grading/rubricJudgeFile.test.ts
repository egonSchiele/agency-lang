import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { sha256Text } from "@/utils/hash.js";
import {
  RUBRIC_JUDGE_PROMPT_SHA256,
  RUBRIC_JUDGE_VERSION,
  rubricJudgeFile,
} from "./rubricJudgeFile.js";

describe("rubricJudgeFile", () => {
  it("points at the bundled rubricJudge.agency that exists on disk", () => {
    const file = rubricJudgeFile();
    expect(file.endsWith("eval/rubricJudge.agency")).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("the prompt file still hashes to the pinned RUBRIC_JUDGE_VERSION", () => {
    const actual = sha256Text(fs.readFileSync(rubricJudgeFile(), "utf8"));
    expect(
      actual,
      `rubricJudge.agency changed. Bump RUBRIC_JUDGE_VERSION (currently ${RUBRIC_JUDGE_VERSION}) in rubricJudgeFile.ts and set RUBRIC_JUDGE_PROMPT_SHA256 to ${actual}.`,
    ).toBe(RUBRIC_JUDGE_PROMPT_SHA256);
  });
});
