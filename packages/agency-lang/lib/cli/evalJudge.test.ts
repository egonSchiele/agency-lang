import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { judgePairwise } from "@/eval/judge/pairwise.js";
import { evalJudge } from "./evalJudge.js";

vi.mock("@/eval/judge/pairwise.js", () => ({
  judgePairwise: vi.fn(),
}));

const mockedJudgePairwise = vi.mocked(judgePairwise);

describe("evalJudge", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedJudgePairwise.mockResolvedValue({
      verdictVersion: 1,
      goal: "prefer precision",
      inputs: [
        { path: "a.eval.json", response: "A" },
        { path: "b.eval.json", response: "B" },
      ],
      winner: "A",
      confidence: 87,
      reasoning: "A is more precise.",
      generatedAt: "2026-06-08T00:00:00.000Z",
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockedJudgePairwise.mockReset();
    logSpy.mockRestore();
  });

  it("writes the verdict JSON to an explicit output path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-judge-"));
    const out = path.join(dir, "verdict.json");

    await evalJudge("a.eval.json", "b.eval.json", {
      goal: "prefer precision",
      out,
    });

    expect(mockedJudgePairwise).toHaveBeenCalledWith(
      "prefer precision",
      "a.eval.json",
      "b.eval.json",
    );
    expect(JSON.parse(fs.readFileSync(out, "utf-8"))).toEqual({
      verdictVersion: 1,
      goal: "prefer precision",
      inputs: [
        { path: "a.eval.json", response: "A" },
        { path: "b.eval.json", response: "B" },
      ],
      winner: "A",
      confidence: 87,
      reasoning: "A is more precise.",
      generatedAt: "2026-06-08T00:00:00.000Z",
    });
    expect(logSpy).toHaveBeenCalledWith("Winner: A (87)");
    expect(logSpy).toHaveBeenCalledWith("Reasoning: A is more precise.");
    expect(logSpy).toHaveBeenCalledWith(`\nWrote verdict to ${out}`);
  });

  it("defaults the verdict path to the current working directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-judge-cwd-"));
    const previous = process.cwd();
    process.chdir(dir);
    try {
      await evalJudge("/tmp/one.eval.json", "/tmp/two.eval.json", {
        goal: "prefer precision",
      });

      expect(fs.existsSync(path.join(dir, "one.vs.two.verdict.json"))).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });
});
