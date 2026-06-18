import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { judgePairwise } from "@/eval/judge/pairwise.js";
import { judgeSuite } from "@/eval/judge/suite.js";
import { evalJudge } from "./evalJudge.js";

vi.mock("@/eval/judge/pairwise.js", () => ({
  judgePairwise: vi.fn(),
}));

vi.mock("@/eval/judge/suite.js", () => ({
  judgeSuite: vi.fn(),
}));

const mockedJudgePairwise = vi.mocked(judgePairwise);
const mockedJudgeSuite = vi.mocked(judgeSuite);

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
    mockedJudgeSuite.mockResolvedValue({
      verdictVersion: 2,
      generatedAt: "2026-06-08T00:00:00.000Z",
      policy: { samples: 3, confidenceThreshold: 50, marginThreshold: 0, positionBias: "swap" },
      winsA: 1,
      winsB: 0,
      ties: 0,
      winner: "A",
      perInput: [],
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockedJudgePairwise.mockReset();
    mockedJudgeSuite.mockReset();
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

  it("writes a suite verdict when comparing run directories with a task file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-judge-runs-"));
    const runA = writeRun(dir, "a", ["capital-france"]);
    const runB = writeRun(dir, "b", ["capital-france"]);
    const tasks = path.join(dir, "tasks.json");
    const out = path.join(dir, "suite-verdict.json");
    fs.writeFileSync(tasks, JSON.stringify({ tasks: [{ task_id: "capital-france", goal: "Return Paris", args: {} }] }));

    await evalJudge(runA, runB, { tasks, out });

    expect(mockedJudgeSuite).toHaveBeenCalledWith(expect.objectContaining({
      runA,
      runB,
      inputs: [{ id: "capital-france", goal: "Return Paris", args: {} }],
      policy: { samples: 3, confidenceThreshold: 50, marginThreshold: 0, positionBias: "swap" },
    }));
    expect(JSON.parse(fs.readFileSync(out, "utf-8"))).toMatchObject({ verdictVersion: 2, winner: "A" });
    expect(logSpy).toHaveBeenCalledWith("Suite winner: A (A 1, B 0, ties 0)");
  });

  it("compares single-task run directories with an inline goal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-judge-inline-"));
    const runA = writeRun(dir, "a", ["capital-france"]);
    const runB = writeRun(dir, "b", ["capital-france"]);

    await evalJudge(runA, runB, { goal: "Return Paris" });

    expect(mockedJudgeSuite).toHaveBeenCalledWith(expect.objectContaining({
      inputs: [{ id: "capital-france", goal: "Return Paris", args: {} }],
    }));
  });

  it("rejects inline goals when single-task run ids differ", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-judge-mismatch-"));
    const runA = writeRun(dir, "a", ["capital-france"]);
    const runB = writeRun(dir, "b", ["capital-germany"]);

    await expect(evalJudge(runA, runB, { goal: "Return Paris" })).rejects.toThrow(/input ids differ/i);
    expect(mockedJudgeSuite).not.toHaveBeenCalled();
  });

  it("rejects inline goals for ambiguous multi-task run directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-judge-ambiguous-"));
    const runA = writeRun(dir, "a", ["task-1", "task-2"]);
    const runB = writeRun(dir, "b", ["task-1"]);

    await expect(evalJudge(runA, runB, { goal: "Return Paris" })).rejects.toThrow(/ambiguous/i);
    expect(mockedJudgeSuite).not.toHaveBeenCalled();
  });

  it("rejects comparisons between a file and a directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-judge-mixed-"));
    const runA = writeRun(dir, "a", ["task-1"]);

    await expect(evalJudge("a.eval.json", runA, { goal: "Return Paris" })).rejects.toThrow(/both inputs/i);
  });

  it("rejects invalid numeric judge policy options", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-judge-policy-"));
    const runA = writeRun(dir, "a", ["task-1"]);
    const runB = writeRun(dir, "b", ["task-1"]);

    await expect(evalJudge(runA, runB, { goal: "Return Paris", samples: Number.NaN })).rejects.toThrow(/samples/);
    await expect(evalJudge(runA, runB, { goal: "Return Paris", confidenceThreshold: Number.NaN })).rejects.toThrow(/confidenceThreshold/);
    await expect(evalJudge(runA, runB, { goal: "Return Paris", marginThreshold: -1 })).rejects.toThrow(/marginThreshold/);
    expect(mockedJudgeSuite).not.toHaveBeenCalled();
  });
});

function writeRun(baseDir: string, runId: string, inputIds: string[]): string {
  const runDir = path.join(baseDir, runId);
  fs.mkdirSync(path.join(runDir, "tasks"), { recursive: true });
  const inputs = inputIds.map((inputId) => {
    const inputDir = path.join(runDir, "tasks", inputId);
    fs.mkdirSync(inputDir, { recursive: true });
    const evalRecordPath = path.join(inputDir, "eval-record.json");
    fs.writeFileSync(path.join(inputDir, "task.json"), JSON.stringify({ id: inputId, goal: "Return Paris", args: {} }));
    fs.writeFileSync(evalRecordPath, JSON.stringify({ recordVersion: 2, evalOutputs: [{ value: "Paris", tMs: 1 }] }));
    return { inputId, status: "success", evalRecordPath, statelogPath: "", workdirPath: "" };
  });
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
    runId,
    runDir,
    agent: "agent.agency:main",
    inputs,
    okCount: inputs.length,
    errorCount: 0,
  }));
  return runDir;
}
