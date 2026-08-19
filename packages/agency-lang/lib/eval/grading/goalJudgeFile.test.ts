import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { sha256Text } from "@/utils/hash.js";
import {
  asJudgeText,
  GOAL_JUDGE_PROMPT_SHA256,
  GOAL_JUDGE_VERSION,
  goalJudgeFile,
  ScalarVerdict,
} from "./goalJudgeFile.js";

describe("goalJudgeFile", () => {
  it("points at the bundled goalJudge.agency that exists on disk", () => {
    const file = goalJudgeFile();
    expect(file.endsWith("eval/goalJudge.agency")).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("the prompt file still hashes to the pinned GOAL_JUDGE_VERSION", () => {
    const actual = sha256Text(fs.readFileSync(goalJudgeFile(), "utf8"));
    expect(
      actual,
      `goalJudge.agency changed. Bump GOAL_JUDGE_VERSION (currently ${GOAL_JUDGE_VERSION}) in goalJudgeFile.ts and set GOAL_JUDGE_PROMPT_SHA256 to ${actual}.`,
    ).toBe(GOAL_JUDGE_PROMPT_SHA256);
  });

  it("ScalarVerdict accepts a {score, reasoning} object", () => {
    expect(ScalarVerdict.parse({ score: 0.5, reasoning: "ok" })).toEqual({
      score: 0.5,
      reasoning: "ok",
    });
  });

  it("asJudgeText returns strings unchanged and JSON-stringifies everything else", () => {
    expect(asJudgeText("Paris")).toBe("Paris");
    expect(asJudgeText({ a: 1 })).toBe('{"a":1}');
    expect(asJudgeText(42)).toBe("42");
  });
});
