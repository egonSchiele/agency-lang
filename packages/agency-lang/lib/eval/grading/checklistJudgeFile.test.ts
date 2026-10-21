import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { sha256Text } from "@/utils/hash.js";
import {
  CHECKLIST_JUDGE_PROMPT_SHA256,
  CHECKLIST_JUDGE_VERSION,
  checklistJudgeFile,
  ChecklistVerdict,
} from "./checklistJudgeFile.js";

describe("checklistJudgeFile", () => {
  it("points at the bundled checklistJudge.agency that exists on disk", () => {
    const file = checklistJudgeFile();
    expect(file.endsWith("eval/checklistJudge.agency")).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("the prompt file still hashes to the pinned CHECKLIST_JUDGE_VERSION", () => {
    const actual = sha256Text(fs.readFileSync(checklistJudgeFile(), "utf8"));
    expect(
      actual,
      `checklistJudge.agency changed. Bump CHECKLIST_JUDGE_VERSION (currently ${CHECKLIST_JUDGE_VERSION}) in checklistJudgeFile.ts and set CHECKLIST_JUDGE_PROMPT_SHA256 to ${actual}.`,
    ).toBe(CHECKLIST_JUDGE_PROMPT_SHA256);
  });

  it("ChecklistVerdict accepts one answer per point with a nullable pass", () => {
    const verdict = {
      points: [
        { name: "one package", pass: true, evidence: "one bin" },
        { name: "releases", pass: null, evidence: "" },
      ],
      note: "One of two.",
    };
    expect(ChecklistVerdict.parse(verdict)).toEqual(verdict);
  });
});
