import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeJudgePairwiseAsync } from "@/cli/util.js";
import { judgePairwise } from "./pairwise.js";

vi.mock("@/cli/util.js", () => ({
  executeJudgePairwiseAsync: vi.fn(),
}));

const mockedJudge = vi.mocked(executeJudgePairwiseAsync);
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const finalResponseFixturesDir = path.join(fixturesDir, "final-response");

describe("judgePairwise", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedJudge.mockResolvedValue({
      winner: "A",
      confidence: "high",
      reasoning: "A is more precise.",
      stdout: "",
      stderr: "",
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    mockedJudge.mockReset();
    stderrSpy.mockRestore();
  });

  it("returns a verdict for v2 records", async () => {
    const a = path.join(finalResponseFixturesDir, "v2-A.eval.json");
    const b = path.join(finalResponseFixturesDir, "v2-B.eval.json");

    const verdict = await judgePairwise("name the capital of India", a, b, {
      baseName: "test-pairwise",
    });

    expect(mockedJudge).toHaveBeenCalledWith({
      baseName: "test-pairwise",
      goal: "name the capital of India",
      responseA: "New Delhi",
      responseB: "Delhi",
    });
    expect(verdict.verdictVersion).toBe(1);
    expect(verdict.goal).toBe("name the capital of India");
    expect(verdict.inputs).toEqual([
      { path: a, response: "New Delhi" },
      { path: b, response: "Delhi" },
    ]);
    expect(verdict.winner).toBe("A");
    expect(verdict.confidence).toBe("high");
    expect(verdict.reasoning).toBe("A is more precise.");
    expect(new Date(verdict.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("returns a verdict for legacy v1 records", async () => {
    const a = path.join(finalResponseFixturesDir, "v1-A.eval.json");
    const b = path.join(finalResponseFixturesDir, "v1-B.eval.json");

    const verdict = await judgePairwise("name the capital of India", a, b);

    expect(mockedJudge).toHaveBeenCalledWith(
      expect.objectContaining({ responseA: "New Delhi", responseB: "Delhi" }),
    );
    expect(verdict.inputs.map((input) => input.response)).toEqual([
      "New Delhi",
      "Delhi",
    ]);
  });

  it("defaults the judge runner base name to a cwd-local pair stem", async () => {
    const a = path.join(finalResponseFixturesDir, "v2-A.eval.json");
    const b = path.join(finalResponseFixturesDir, "v2-B.eval.json");

    await judgePairwise("name the capital of India", a, b);

    expect(mockedJudge).toHaveBeenCalledWith(
      expect.objectContaining({ baseName: "v2-A.vs.v2-B" }),
    );
  });

  it("warns and judges an empty string when v2 output is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "missing.eval.json");
    const b = path.join(finalResponseFixturesDir, "v2-B.eval.json");
    fs.writeFileSync(a, JSON.stringify({ recordVersion: 2, evalOutputs: [] }));

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedJudge).toHaveBeenCalledWith(
      expect.objectContaining({ responseA: "", responseB: "Delhi" }),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${a} has no recorded final response`),
    );
    expect(verdict.inputs[0].response).toBeNull();
  });

  it("warns and judges an empty string when legacy finalResponse is null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "missing-v1.eval.json");
    const b = path.join(finalResponseFixturesDir, "v2-B.eval.json");
    fs.writeFileSync(a, JSON.stringify({ recordVersion: 1, finalResponse: null }));

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedJudge).toHaveBeenCalledWith(
      expect.objectContaining({ responseA: "", responseB: "Delhi" }),
    );
    expect(verdict.inputs[0].response).toBeNull();
  });

  it("stringifies non-string v2 output values", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "object.eval.json");
    const b = path.join(finalResponseFixturesDir, "v2-B.eval.json");
    fs.writeFileSync(
      a,
      JSON.stringify({
        recordVersion: 2,
        evalOutputs: [{ value: { reply: "hello" }, threadId: "0", tMs: 1 }],
      }),
    );

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedJudge).toHaveBeenCalledWith(
      expect.objectContaining({ responseA: '{"reply":"hello"}' }),
    );
    expect(verdict.inputs[0].response).toBe('{"reply":"hello"}');
  });

  it("preserves truncated metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "truncated.eval.json");
    const b = path.join(finalResponseFixturesDir, "v2-B.eval.json");
    fs.writeFileSync(
      a,
      JSON.stringify({
        recordVersion: 2,
        evalOutputs: [{ value: "partial", threadId: "0", tMs: 1, truncated: true }],
      }),
    );

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedJudge).toHaveBeenCalledWith(
      expect.objectContaining({ responseA: "partial" }),
    );
    expect(verdict.inputs[0]).toEqual({
      path: a,
      response: "partial",
      truncated: true,
    });
  });

  it("throws a friendly error when a record file is missing", async () => {
    const missing = path.join(os.tmpdir(), "missing-agency-record.eval.json");

    await expect(
      judgePairwise("goal", missing, path.join(fixturesDir, "v2-B.eval.json")),
    ).rejects.toThrow(missing);
    expect(mockedJudge).not.toHaveBeenCalled();
  });
});
