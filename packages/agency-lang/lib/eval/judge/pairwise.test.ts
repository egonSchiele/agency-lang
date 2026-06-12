import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAgencyAgent } from "@/cli/runAgencyAgent.js";
import { judgePair, judgePairwise } from "./pairwise.js";

vi.mock("@/cli/runAgencyAgent.js", () => ({
  runAgencyAgent: vi.fn(),
}));

const mockedRunAgencyAgent = vi.mocked(runAgencyAgent);
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("judgePairwise", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedRunAgencyAgent.mockResolvedValue({
      data: {
        winner: "A",
        confidence: 87,
        reasoning: "A is more precise.",
      },
      stdout: "",
      stderr: "",
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    mockedRunAgencyAgent.mockReset();
    stderrSpy.mockRestore();
  });

  it("returns a verdict for v2 records", async () => {
    const a = path.join(fixturesDir, "v2-A.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");

    const verdict = await judgePairwise("name the capital of India", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: "judgePairwise.agency",
      node: "judgePairwise",
      args: {
        goal: "name the capital of India",
        responseA: "New Delhi",
        responseB: "Delhi",
      },
      config: {},
    }));
    expect(verdict.verdictVersion).toBe(1);
    expect(verdict.goal).toBe("name the capital of India");
    expect(verdict.inputs).toEqual([
      { path: a, response: "New Delhi" },
      { path: b, response: "Delhi" },
    ]);
    expect(verdict.winner).toBe("A");
    expect(verdict.confidence).toBe(87);
    expect(verdict.reasoning).toBe("A is more precise.");
    expect(new Date(verdict.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("returns a task verdict from judgePair", async () => {
    const a = path.join(fixturesDir, "v2-A.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");

    const verdict = await judgePair({
      taskId: "capital-india",
      goal: "name the capital of India",
      recordPathA: a,
      recordPathB: b,
    });

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: "judgePairwise.agency",
      node: "judgePairwise",
      args: {
        goal: "name the capital of India",
        responseA: "New Delhi",
        responseB: "Delhi",
      },
      config: {},
    }));
    expect(verdict).toMatchObject({
      taskId: "capital-india",
      goal: "name the capital of India",
      winner: "A",
      confidence: 87,
      samples: [{ winner: "A", confidence: 87, order: "AB" }],
      inputs: [
        { path: a, response: "New Delhi", status: "ok" },
        { path: b, response: "Delhi", status: "ok" },
      ],
    });
    expect(new Date(verdict.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("returns a verdict for legacy v1 records", async () => {
    const a = path.join(fixturesDir, "v1-A.eval.json");
    const b = path.join(fixturesDir, "v1-B.eval.json");

    const verdict = await judgePairwise("name the capital of India", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({ responseA: "New Delhi", responseB: "Delhi" }),
    }));
    expect(verdict.inputs.map((input) => input.response)).toEqual([
      "New Delhi",
      "Delhi",
    ]);
  });

  it("warns and judges an empty string when v2 output is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "missing.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");
    fs.writeFileSync(a, JSON.stringify({ recordVersion: 2, evalOutputs: [] }));

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({ responseA: "", responseB: "Delhi" }),
    }));
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${a} has no recorded final response`),
    );
    expect(verdict.inputs[0].response).toBeNull();
  });

  it("warns and judges an empty string when legacy finalResponse is null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "missing-v1.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");
    fs.writeFileSync(a, JSON.stringify({ recordVersion: 1, finalResponse: null }));

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({ responseA: "", responseB: "Delhi" }),
    }));
    expect(verdict.inputs[0].response).toBeNull();
  });

  it("stringifies non-string v2 output values", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "object.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");
    fs.writeFileSync(
      a,
      JSON.stringify({
        recordVersion: 2,
        evalOutputs: [{ value: { reply: "hello" }, threadId: "0", tMs: 1 }],
      }),
    );

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({ responseA: '{"reply":"hello"}' }),
    }));
    expect(verdict.inputs[0].response).toBe('{"reply":"hello"}');
  });

  it("preserves truncated metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "truncated.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");
    fs.writeFileSync(
      a,
      JSON.stringify({
        recordVersion: 2,
        evalOutputs: [{ value: "partial", threadId: "0", tMs: 1, truncated: true }],
      }),
    );

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({ responseA: "partial" }),
    }));
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
    expect(mockedRunAgencyAgent).not.toHaveBeenCalled();
  });

  it("rejects malformed judge confidence", async () => {
    mockedRunAgencyAgent.mockResolvedValue({
      data: { winner: "A", confidence: 101, reasoning: "too high" },
      stdout: "",
      stderr: "",
    });

    await expect(
      judgePairwise("goal", path.join(fixturesDir, "v2-A.eval.json"), path.join(fixturesDir, "v2-B.eval.json")),
    ).rejects.toThrow(/confidence/);
  });
});
