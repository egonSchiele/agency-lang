import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { asJudgeText, goalJudgeFile, ScalarVerdict } from "./goalJudgeFile.js";

describe("goalJudgeFile", () => {
  it("points at the bundled goalJudge.agency that exists on disk", () => {
    const file = goalJudgeFile();
    expect(file.endsWith("eval/goalJudge.agency")).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("ScalarVerdict accepts a {score, reasoning} object", () => {
    expect(ScalarVerdict.parse({ score: 0.5, reasoning: "ok" })).toEqual({ score: 0.5, reasoning: "ok" });
  });

  it("asJudgeText returns strings unchanged and JSON-stringifies everything else", () => {
    expect(asJudgeText("Paris")).toBe("Paris");
    expect(asJudgeText({ a: 1 })).toBe('{"a":1}');
    expect(asJudgeText(42)).toBe("42");
  });
});
